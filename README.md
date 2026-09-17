# BiliFastCDN

Surge iOS 模块：把 B 站下发的 CDN 请求换到指定主机。**后端移植自 [Biliverse/Redirect](https://github.com/Biliverse/Redirect)（Apache-2.0）的 Surge 实现**，另加一张状态面板。

给海外用户看冷门视频时用 —— 那些视频常被调度到 PCDN / 家宽节点，跨境拉流会卡；这个模块把它换到官方 CDN 镜像。

---

## 声明

**AI Coding。** 本仓库代码由 AI 助手（Qoder）生成，不是人工逐行编写。

- v1.0.0 起：后端是 **Biliverse/Redirect** v0.2.24 的 Surge 实现移植（Apache-2.0），改动清单与许可全文见
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- v0.1.0–v0.5.0：移植自 [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator)（MIT）的测速排名引擎；
  那段代码已被整体替换，署名作为历史保留
- 面板是本项目新增的（原实现没有面板）
- 本仓库自身的代码用 MIT（见 [LICENSE](LICENSE)）

## 它做什么

```
Surge（不需要 MitM：App 的分片是明文 http）
        │
        ├─ [URL Rewrite]  12 条静态规则：港澳台 *ov / cn-hk-eq-*、Akamai、国际版 *bstar1
        │                的 upgcxcode 请求直接换 Host —— 在 Surge 重写引擎里执行，不调用脚本
        │
        ├─ [Script]       MCDN（换端口 / cdn / sid / 代理包裹）与 PCDN（:4480、:9305）
        │                这两种形态静态规则表达不了，交给脚本判定
        │
        └─ [Panel]        状态卡片：生效目标 + 脚本计数
```

**为什么把大头交给静态规则**：Surge 每次调用脚本都要重新加载并跑一遍，真机实测一次 20–300ms，而一段视频的分片是几百上千次请求。静态 `[URL Rewrite]` 不产生这种开销，所以常规镜像走规则、只有 MCDN/PCDN 走脚本。

**MCDN / PCDN 分别怎么处理**（逐条对照 Redirect 的 `Request.mjs`）：

| 形态 | 处理 |
| --- | --- |
| `*.mcdn.bilivideo.cn` 无端口 | 按路径补端口：`/v1/resource/` → http 8000 / https 8082；`/upgcxcode/` → http 9102 / https 4483 |
| `*.mcdn.bilivideo.cn:486` | 有 `cdn` 参数 → `d1--<cdn>.bilivideo.com`；有 `sid` → `<sid>.bilivideo.com` |
| `*:4483` / `*:9102` | 换成 MCDN 代理包裹 `http://proxy-tf-all-ws.bilivideo.com/?url=<原始地址>`；已经是 `.bilivideo.com` 或带 `originalUrl` 的跳过（防回环） |
| `*:4480`（PCDN） | 回到 `xy_usource` 指向的原节点，没有就落到 `hostPcdn`；协议固定成 http |
| `*:9305`（PCDN） | 主机名藏在路径第一段里，把它提出来当 Host |

## 文件

| 文件 | 说明 |
| --- | --- |
| `BiliFastCDN.sgmodule` | 模块本体：`[General]` / `[URL Rewrite]` / `[Script]` / `[Panel]` / `[MITM]` |
| `bili-cdn.js` | 请求改写判定（MCDN/PCDN）+ 面板渲染 |
| `test/verify.html` | 离线验证套件，110 项断言，用浏览器跑 |
| `LICENSE` | MIT（本仓库自身代码） |
| `THIRD-PARTY-NOTICES.md` | Redirect 的 Apache-2.0 全文与变更说明 |

## 配置项

模块参数表里可改：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `hostOverseaVideo` | `upos-sz-mirrorali.bilivideo.com` | 港澳台（`*ov`、`cn-hk-eq-*`）与 Akamai 分片要换到的主机 |
| `hostBStar` | `upos-sz-mirrorali.bilivideo.com` | 国际版（`*bstar1`）分片要换到的主机 |
| `hostPcdn` | `upos-sz-mirrorali.bilivideo.com` | PCDN（`:4480` 没有 `xy_usource` 时）要换到的主机 |
| `hostMcdn` | `proxy-tf-all-ws.bilivideo.com` | MCDN（`:4483`/`:9102`）的代理包裹目标 |
| `debug` | `false` | 每次判定写进请求详情注释 |

默认值与上游 `database.mjs` 一致。可选主机（上游 `arguments-desc` 列的清单）：
`upos-sz-mirrorali` / `upos-sz-mirrorcos` / `upos-sz-mirrorhw`（大陆）、
`upos-sz-mirroraliov` / `upos-sz-mirrorcosov` / `upos-sz-mirrorhwov`（海外）、
`cn-hk-eq-01-01` … `cn-hk-eq-01-14`（香港 Equinix IX）。

**发版时版本号要改两处**：`bili-cdn.js` 的 `VERSION`、模块的 `#!desc` 与三条 `script-path` 的 `?v=`。
少改一处会出现"改了却没生效" —— Surge 对模块文件与远程脚本都会缓存（远程脚本的缓存由
`script-update-interval` 控制，本模块设为 30 分钟；模块文件本身也要重新安装/更新一次）。
排查任何问题前，先比对模块列表的 `#!desc` 与面板标题里的版本号。

## 怎么确认生效

**看面板。** 策略选择页的「B站CDN」卡片：

```
静态规则（港澳台/国际版）→ sz-mirrorali
脚本 MCDN → proxy-tf-all-ws · PCDN → sz-mirrorali
脚本 命中9 改写4
最近 MCDN换端口：xy1x2x3x4xy.mcdn.bilivideo.cn → xy1x2x3x4xy.mcdn.bilivideo.cn:9102
```

- **第一行**是静态规则的目标。静态重写在 Surge 引擎里执行，**不经过脚本、也不计入下面的计数**；
  想知道它有没有生效，看请求记录里那条分片请求的 Host 变成了什么。
- **第二行**是脚本里 MCDN / PCDN 的目标。
- **计数**只统计落到脚本里的请求。「命中 0」通常意味着没碰到 MCDN/PCDN（正常），
  而不是模块没工作。

**看 debug 输出。** 打开 `debug` 后，脚本的判定会写进**那条请求的「注释」**（Surge 手册：
`console.log` 输出 "also appears in the request's notes"），不是日志页；导出的 HAR 里就是每个
entry 的 `comment` 字段。日志页只收 cron/面板这类没有对应请求的脚本输出，且需要
`[General] loglevel = info`。

> **`debug` 不是常开开关。** 手册写明它会 reload 脚本（每次执行重新加载），实测每次调用
> 150–350ms。诊断完请关掉。

## 与原项目的差异

| 方面 | Redirect | 本项目 |
| --- | --- | --- |
| 客户端 | Surge / Loon / Stash / Shadowrocket（handlebars 模板 + rollup 构建） | 只做 Surge 版 |
| 配置 | `$argument` + BoxJs（`PersistentStore`）双通道，可切 `Storage` 模式 | 只用 Surge 模块参数表 |
| 设置界面 | 另配 PreferencePanes / BoxJs 前端 | 无，参数表 + 状态面板 |
| 请求脚本覆盖面 | 含一条 `^https?://.+\.bilivideo\.com/upgcxcode/` 的宽 pattern（所有镜像都进脚本） | **只让 MCDN/PCDN 进脚本**：常规镜像由静态规则处理，省掉每条分片的脚本开销 |
| 面板 | 无 | 有 |

## 已知限制

- **静态规则只覆盖 `upgcxcode` 路径**。上游如此：`/v1/resource/` 与其它路径不在规则里，MCDN 的
  `/v1/resource/` 只补端口不换主机。
- **不在名单里的主机不会被改**：`upos-sz-mirror14b` 之类的 PCDN 家族、以及客户端自己 HTTPDNS 得到的
  裸 IP 地址，规则与脚本都不动它们（上游同样如此）。裸 IP 形式在真机上出现过，换成主机名后
  曾因本地解析到不服务该域名的边缘而 403。
- **换到别的主机等于放弃了播放器自己的备选**：B 站的 playurl 会给主备两个候选，把其中一个换走之后，
  剩下那个就是唯一来源。上游的静态目标是**固定主机**，本项目保持同样的语义。
- **`[MITM]` 只在你要改写 HTTPS 分片时才需要**。官方 App 的分片是明文 http，不需要 MitM；
  但 HTTPS 的请求不解密就看不见，也就无法重写。
- **多连接聚合（IDM 那种）做不到**：Surge 脚本只能改写请求 URL，没法把一条客户端请求拆成多条 Range
  并发再合并。播放器本来就在并发拉分片。
- **面板只统计脚本**：静态规则命中多少条无法计数（它们不经过脚本），别把「命中 0」当成没生效。

## 测试

```bash
chrome --headless=new --disable-gpu --allow-file-access-from-files \
       --virtual-time-budget=20000 --dump-dom test/verify.html
```

输出 `ALL n CHECKS PASSED` 或失败明细。110 项断言覆盖：

- URL 原语与参数解析（含 `xy_usource` 的百分号解码）
- 配置：上游默认值、参数覆盖、snake_case 别名、粘贴整条 URL 时只取主机名、占位符未替换时回落默认值
- 主机名分类：固定名单 + `*ov` / `cn-hk-eq-*` / `*bstar1` 通配，大陆镜像一律不动
- MCDN / PCDN 端口矩阵：无端口补端口、`:486` 的 `cdn`/`sid`、`:4483`/`:9102` 的代理包裹与两种回环跳过、
  `:4480` 的 `xy_usource`、`:9305` 的路径内主机
- 请求角色：改写结果、签名 query 逐字节保留、计数、debug 行长度与不落签名
- 面板角色：目标与计数展示、样式、不发任何请求（`$httpClient` 一旦被调用即失败）
- **模块文件与脚本的一致性**：12 条静态规则、`force-http-engine-hosts` 的端口、只有两条请求脚本、
  面板挂载、版本号三处一致、旧引擎的参数已清干净

## 许可证

本仓库自身代码：MIT（[LICENSE](LICENSE)）。移植部分的许可是 Apache-2.0，全文与变更说明见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
