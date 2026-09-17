# BiliFastCDN

Surge iOS 模块：把 B 站下发的 CDN 请求换到**自动测速选出的最快节点**。

- 后端（分类判定、MCDN/PCDN 处理）移植自 [Biliverse/Redirect](https://github.com/Biliverse/Redirect)（Apache-2.0）
- 测速与选最快是本项目加的：上游只有固定主机名，没有测量

给海外用户看冷门视频时用 —— 那些视频常被调度到 PCDN / 家宽节点，跨境拉流会卡；这个模块把它换到官方 CDN 镜像里当前最快的一个。

---

## 声明

**AI Coding。** 本仓库代码由 AI 助手（Qoder）生成，不是人工逐行编写。

- CDN 分类与 MCDN/PCDN 判定：移植 **Biliverse/Redirect** v0.2.24 的 Surge 实现（Apache-2.0），
  改动清单与许可全文见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- 响应侧模块（`BiliFastCDN.PlayURL`）按它的 response 分支思路**自写**：上游那版 beta 产物所在的
  分支已不存在，无法直接搬运（详见 THIRD-PARTY-NOTICES 里的说明）
- 测速、排名、状态面板为本项目自写
- v0.1.0–v0.5.0 曾移植 [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator)（MIT）的引擎，
  那段代码已被整体替换，署名作为历史保留
- 本仓库自身代码用 MIT（见 [LICENSE](LICENSE)）

## 两个模块，二选一

| 模块 | 改写位置 | 代价 |
| --- | --- | --- |
| `BiliFastCDN.sgmodule` | **请求侧**：每条 CDN 分片请求进来时改 Host | 每条分片调用一次脚本（实测 20–43ms）；不需要 MitM |
| `BiliFastCDN.PlayURL.sgmodule` | **响应侧**：拿到 playurl 响应后把里面的媒体地址改掉 | 分片不再经过脚本；需要 MitM，且要解开 gzip 帧才能改 |

两个都装会让同一条请求被两条路径改写，没有必要。想先看哪个好，就装哪个，面板的计数能看出各自改了多 少条。

## 三个脚本

| 文件 | 角色 |
| --- | --- |
| `bili-cdn.js` | 请求侧改写（判定逐条对照 Redirect 的 `Request.mjs`） |
| `bili-playurl.js` | 响应侧改写（JSON + gRPC/protobuf，字节级） |
| `bili-speedtest.js` | 两个模块共用的**测速（cron）+ 状态面板** |

测速把排名写进 `$persistentStore`（`bili_fast_cdn.rank.v2`），两个后端读同一份；计数写在
`bili_fast_cdn.stats.v1`，面板读同一份。

## 它做什么

**1. 测速与排名（cron，默认 30 分钟检查一次，结果满 6 小时才重测）**

用真实签名分片做 `Range` 请求（恰好 1MB）测吞吐，候选池是 8 个 upos 镜像：

```
upos-sz-mirrorcosov / upos-sz-mirroraliov / upos-sz-mirrorhwov / upos-sz-mirrorali
upos-tf-all-hw / upos-sz-mirrorhw / upos-sz-mirrorcos / upos-tf-all-tx
```

Akamai 不列入候选池：它对 upos 签名路径返回 403，测不出结果。
样本优先用响应侧模块抓到的真实分片地址；没有就去公开接口引导一个。淘汰的候选（403/超时/HTML 错误页）
不参与排名，并在面板上标出来。

**2. 目标主机：`auto` 或固定主机名**

四个目标参数默认都是 `auto`：

| 参数 | 覆盖的来源 | `auto` 时的取值 |
| --- | --- | --- |
| `hostOverseaVideo` | 港澳台（`*ov`、`cn-hk-eq-*`）与 Akamai | 测速第一 |
| `hostBStar` | 国际版（`*bstar1`） | 测速第一 |
| `hostPcdn` | 其余镜像、PCDN 回原节点 | 测速第一 |
| `hostMcdn` | MCDN（`:4483`/`:9102` 代理包裹） | 固定（不参与测速） |

填主机名就固定用它，不再看排名。

**3. 改写判定**（两个模块用同一套，逐条对照 Redirect 的 `GET/HEAD` 分支）

| 形态 | 处理 |
| --- | --- |
| 港澳台 `*ov` / `cn-hk-eq-*`、Akamai、国际版 `*bstar1` | 换到对应分类目标 |
| 其它 `upos-*.bilivideo.*` 镜像 | `auto` 时收敛到 `hostPcdn`；固定目标时保持上游语义（它们就是目标本身，放过） |
| `*.mcdn.bilivideo.cn` 无端口 | 按路径补端口：`/v1/resource/` → http 8000 / https 8082；`/upgcxcode/` → http 9102 / https 4483 |
| `*.mcdn.bilivideo.cn:486` | `cdn` 参数 → `d1--<cdn>.bilivideo.com`；`sid` → `<sid>.bilivideo.com` |
| `*:4483` / `*:9102` | 换成 MCDN 代理包裹 `http://<hostMcdn>/?url=<原始地址>`；已是 `.bilivideo.com` 或带 `originalUrl` 的跳过（防回环） |
| `*:4480`（PCDN） | 回到 `xy_usource` 指向的原节点，没有就落到 `hostPcdn`；协议固定 http |
| `*:9305`（PCDN） | 主机名藏在路径第一段里，提出来当 Host |

**4. 响应侧模块的字节级改写**：没有可换的主机名时输出与输入**逐字节相同**；protobuf 改写后会再校验一次
能否解析，失败就整段放弃；gzip 帧用 `$utils.ungzip` 解开改写后按"未压缩帧"（flag=0）发回 ——
Surge 只有 ungzip、没有 gzip，压不回去。

## 文件

| 文件 | 说明 |
| --- | --- |
| `BiliFastCDN.sgmodule` | 请求侧模块 |
| `BiliFastCDN.PlayURL.sgmodule` | 响应侧模块 |
| `bili-cdn.js` / `bili-playurl.js` / `bili-speedtest.js` | 三个脚本 |
| `test/verify.html` | 离线验证套件，110 项断言，用浏览器跑 |
| `LICENSE` / `THIRD-PARTY-NOTICES.md` | MIT（自身） / 上游 Apache-2.0 全文与变更说明 |

**发版时版本号要改两处**：`#!desc` 与各 `script-path` 的 `?v=`（两个模块都要），三个脚本的 `VERSION`
用同一个值。Surge 对模块文件与远程脚本都会缓存（远程脚本由 `script-update-interval` 控制，本模块设为 30 分钟），
排查问题前先比对模块列表的 `#!desc` 与面板标题的版本号。

## 怎么确认生效

**看面板**（两个模块的面板都由 `bili-speedtest.js` 渲染）：

```
最快 tf-all-hw · 33.4 Mbps
测速 3 分钟前 · 8 个节点 · 剔除 sz-mirrorhwb(500)
改写 命中12 改写9
最近 港澳台：hz-mirrorakam → tf-all-hw
```

- 点卡片右上角刷新按钮 = **立即重测**；自动刷新只读缓存，不发请求。
- 「剔除 xxx(状态码)」= 这一轮没应答的候选，它们不可能是好目标。
- 命中 >0 而改写 0：流量到了但无需改写（例如请求本来就在最快的那台上）。

**看 debug 输出**：打开 `debug` 后判定写进**那条请求的「注释」**（Surge 手册：`console.log` 输出
"also appears in the request's notes"），不是日志页；导出的 HAR 里就是每个 entry 的 `comment` 字段。

> **`debug` 不是常开开关。** 手册写明它会 reload 脚本（每次执行重新加载），实测每次调用 150–350ms。
> 诊断完请关掉。

## 已知限制

- **请求侧模块每条分片都要跑一次脚本**（实测 20–43ms/次）。想彻底避开这笔开销就用响应侧模块，
  或把四个目标都填成固定主机名（改写仍是脚本在做，但至少不受排名波动影响）。
- **响应侧模块要 MitM 才能看到 fetch 到的响应**。官方 App 的 playurl 走 gRPC（`grpc.biliapi.net`），
  响应体实测是 **gzip 帧**，所以必须开 `$utils.ungzip` 那条路径才改得动；改不动时面板显示
  「压缩N」而不是报错。
- **换到别处等于放弃播放器自己的备选**：playurl 会给主备两个候选，`auto`/固定目标都会把同一分类的
  地址收敛到同一个主机，剩下那个就是唯一来源。这是"选最快"的固有代价。
- **Akamai 不在候选池**：它对 upos 签名路径返回 403，测不出吞吐。想把 Akamai 换掉就把它归到
  `hostOverseaVideo` 里（判定里 Akamai 属于港澳台一类）。
- **裸 IP 形式的地址不动**：客户端自己做 HTTPDNS 拿到的 IP 形式分片地址，规则和脚本都不碰
  （真机上换成主机名后曾因本地解析不到而 403）。
- **多连接聚合（IDM 那种）做不到**：脚本只能改写 URL，没法把一条请求拆成多条 Range 再合并；
  播放器本来就在并发拉分片。
- **测速排名只代表"测速那一刻、那条解析路径"**：同一个主机名在不同网络下可能落到不同边缘，
  所以排名有时间戳（6 小时过期）、被否掉的候选会记进面板。

## 测试

```bash
chrome --headless=new --disable-gpu --allow-file-access-from-files \
       --virtual-time-budget=25000 --dump-dom test/verify.html
```

输出 `ALL n CHECKS PASSED` 或失败明细。110 项断言覆盖：

- URL 原语、参数解析（含 `xy_usource` 的百分号解码）、粘贴整条 URL 时只取主机名
- `auto`：有排名时收敛到第一、无排名时回落兜底主机、固定主机名压过排名、`hostPcdn` 固定时大陆镜像放过
- MCDN / PCDN 端口矩阵：补端口、`:486` 的 `cdn`/`sid`、`:4483`/`:9102` 代理包裹与两种回环跳过、
  `:4480` 的 `xy_usource`、`:9305` 的路径内主机
- 请求角色：改写结果、签名 query 逐字节保留、计数与最近一次改写、debug 行长度
- 响应侧 JSON：`baseUrl`/`backupUrl`/`durl` 一起改、已在目标上则逐字节放过、无媒体地址则放过并只计一次调用
- 响应侧 gRPC：等长/变长替换、帧长度前缀重算、压缩帧在无 `$utils` 时原样放过、有 `$utils` 时解压改写
  并按未压缩帧发回、非帧结构放过
- 测速：候选池不含 Akamai、排序（吞吐优先、同速看延迟）、样本挑选跳过 mcdn、面板文案与样式、
  点刷新会真的发探测且超时是秒级
- **两个模块与脚本的一致性**：条数、版本号三处一致、cron/面板指向 `bili-speedtest.js`、
  响应侧四条 pattern 与 `binary-body-mode`/`engine=webview`、旧引擎参数已清干净

## 许可证

本仓库自身代码：MIT（[LICENSE](LICENSE)）。移植与参考部分的许可见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)（Redirect Apache-2.0 全文 + 变更说明）。
