# BiliFastCDN

Surge iOS 模块：劫持 B 站 `playurl` / 直播 `playinfo` 接口，把视频 CDN 域名重写为**本机实测最快**的节点。

给海外用户看冷门视频时用 —— 那些视频常被调度到 PCDN / 家宽节点，跨境拉流会卡；这个模块把它换到官方 CDN 镜像里测速最快的一个。

---

## 声明

**AI Coding。** 本仓库代码由 AI 助手（Qoder）生成，不是人工逐行编写。核心判定逻辑是在阅读参考实现后**逐条移植**的，而不是重新发明：

- 参考项目：[realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator)（MIT）
- 参考版本：`bilibili-accelerator.user.js` v0.4.1
- 移植范围：CDN 主机分类判定、候选节点池、直播 `url_info` 过滤、`backupUrl` 扇出、force / bad-only 语义、`/live-bvc/` 排除规则、明文 http 分片改写
- 参考 [Biliverse/Redirect](https://github.com/Biliverse/Redirect)（Apache-2.0）两处做法：`binary-body-mode` + gRPC 方法名 pattern 的拦截方式，
  以及按来源主机名分类的判定条件（`*ov` / `cn-hk-eq-*` → 港澳台，`*bstar1` → 国际版）；
  **字节级 protobuf 改写器与全部判定实现均为本项目自写，未复制其代码**
- 完整署名与上游许可全文：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

**真机验证范围。** 脚本逻辑有 304 项离线断言覆盖（含与上游逐条对照与合成 protobuf fixture）。
已在真机确认：模块安装、`[Panel]` 段落、明文 http 分片改写可用（把 Akamai 分片换到 `upos-sz-mirroraliov` 后播放正常）。
gRPC 层真机已确认一半：**默认引擎确实交付了 Uint8Array body**（真机 `gRPC 触发 13 次`），
但当时 `改写 0 次` —— 根因是 body 是 gRPC **帧**序列而非裸 protobuf，解析器在第一个字节（压缩标志位）就放弃了，
v0.1.5 已修（见「已知限制」）。修正后的改写效果仍待真机确认；出问题可以单独关 `grpcRewrite`。

## 它做什么

```
Surge（接口/Grpc 层需要 MitM，分片层不需要）
        │
        ├─ gRPC 层   http-response + binary-body-mode：字节级改写 protobuf 里的
        │            CDN 主机名（官方 App 的 playurl 走这条）
        │
        ├─ 接口层   http-response：解析 JSON playurl / getRoomPlayInfo，
        │            改写媒体域名与直播 url_info（网页版走这条）
        │
        ├─ 分片层   http-request：改写明文 http 的分片请求（兜底）
        │
        └─ 测速层   cron（默认每 30 分钟检查、结果满 6 小时才重测）：
                    用真实签名分片做 Range 请求测吞吐，排名写入 $persistentStore
```

**为什么需要 gRPC 层**：官方 App 的 playurl 走 `grpc.biliapi.net`（protobuf），JSON 接口层碰不到它。真机 HAR 显示 App 调的是
`bilibili.app.playerunite.v1.Player/PlayViewUnite` 与 `bilibili.app.playurl.v1.PlayURL/PlayConf`，而它拿到的分片落在
`upos-hz-mirrorakam.akamaized.net`（Akamai）。

**注意两者的分工**：gRPC 层（字节层）**只清劣质节点，不碰健康节点**。因为 JSON 层改写后能补 `backupUrl` 扇出，
而 protobuf 里补不了 —— 把健康节点也收敛到同一个 host 等于拆掉播放器自己的多 CDN 容错，那个 host 一抖整段就卡。
「选最快」交给按请求改写的分片层，那里失败只影响单个分片。想强制字节层也换（例如固定港澳台目标），
把对应分类参数从 `auto` 改成具体主机名即可。

**分片层是兜底**：真实分片请求是明文 http（不需要 MitM）。真机验证过把 `upos-hz-mirrorakam.akamaized.net` 换成测速最快的
`upos-sz-mirroraliov` 后播放正常 —— URL 上的 `upsig`/`uparams` 校验通过，Akamai 的 `hdnts` token 被忽略。
即使 gRPC 层因为 gzip 或缓冲上限跳过，分片层仍能兜住。

**视频流不做 MitM。** 分片层处理的是明文 http，gRPC 层与接口层只解密接口响应，都不让 Surge 参与视频流加解密。

**仍未覆盖**：B站的 P2P 通道（`*.solseed.cn` tracker）不是 HTTP，Surge 无法改写。

## 文件

| 文件 | 说明 |
| --- | --- |
| `BiliFastCDN.sgmodule` | 模块本体：`[Script]` / `[Panel]` / `[MITM]` / 参数表 |
| `bili-cdn.js` | 一个文件四种角色：接口改写 / 分片改写 / 测速 / 面板，按运行上下文分派 |
| `test/verify.html` | 离线验证套件，304 项断言，用浏览器跑 |
| `LICENSE` | MIT |
| `THIRD-PARTY-NOTICES.md` | 上游 realzza/bilibili-accelerator 的 MIT 署名 |

## 配置项

模块参数表里可改（Surge 的模块参数编辑界面）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mode` | `smart` | `smart` 有测速结果时全量改写、无结果时只动劣质节点；`force` 总是改写；`bad-only` 只改写 PCDN / 劣质节点；`off` 关闭改写 |
| `grpcRewrite` | `true` | 是否启用 gRPC（protobuf）响应改写 |
| `mediaRewrite` | `true` | 是否启用明文 http 分片改写（官方 App 只有这层覆盖得到） |
| `hostPcdn` / `hostOversea` / `hostBStar` | `auto` | 分类目标覆盖。`auto` = 用测速排名第一；填主机名则固定用它。分类按**来源主机名**判定：`upos-sz-mirror*ov` 与 `cn-hk-eq-*` 属港澳台，`*bstar1` 属国际版，其余按大陆 |
| `hostMcdn` | `proxy-tf-all-ws.bilivideo.com` | MCDN 的目标节点（默认代理包裹，与 realzza、Biliverse/Redirect 两者的默认一致） |
| `backupFanout` | `true` | 把候选节点写进 `backupUrl`，让播放器自己也能容错切换 |
| `liveFilter` | `true` | 从直播 `url_info` 中剔除 PCDN 节点 |
| `notify` | `true` | 测速完成后发通知 |
| `debug` | `false` | 每次判定写进日志与请求详情注释，且每次改写发一条通知（30 秒内不重复） |

改 `bili-cdn.js` 顶部常量还能调：候选节点池 `CANDIDATE_POOL`（按自己地区增删）、
`DEFAULTS` 里的测速有效期 / 样本有效期 / 探测超时与字节数。测速频率改模块里的 `cronexp`。
`mcdnStrategy`（`proxy` 代理包裹 / `replace` 换 host / `off`）也只在 `DEFAULTS` 里，不在参数表。

### 发版时版本号要改三处

`bili-cdn.js` 的 `VERSION`、五条 `script-path` 的 `?v=`、模块头部的 `#!desc=`。少改一处就会出现"改了却没生效" ——
**Surge 对模块文件和远程脚本都会缓存**：

- 远程脚本的缓存由 `script-update-interval` 控制（默认 `86400` = 24 小时，本模块设为 `1800` = 30 分钟）
- 模块文件本身也会缓存，所以 `#!desc` 带版本号 —— 模块列表里一眼能看出拿到的是哪一版
- `raw.githubusercontent.com` 自己也有 CDN 缓存，刚 push 完可能取到旧内容（等一两分钟）

判断设备实际加载了哪一版：**模块列表看 `#!desc`，面板标题看 `VERSION`**。排查任何问题前先看这两处。

## 怎么确认生效

**看面板。** 策略选择页的「B站CDN」卡片：

```
目标 sz-mirroraliov · 72.3 Mbps
测速 1 分钟前 · 8 个节点
接口 触发12 媒体9 改写27
gRPC 扫描23 改写21 · 最近 41KB 帧1 改写21
分片 扫描156 改写150
最近 gRPC替换：hz-mirrorakam → sz-mirroraliov
```

gRPC 那行尾巴是最近一次的**帧结构**，改写为 0 时靠它定位（不必翻日志）：

| 尾巴里出现 | 含义 |
| --- | --- |
| `压缩N` | 有 N 个压缩帧（通常是 gzip），替换后无法重新压缩，只能放行 |
| `非帧` | body 不是 gRPC 帧结构（可能不是本模块该管的响应） |
| 都没有、且 `改写0` | 真的没有可换的主机名（例如 URL 用的是裸 IP 形式的 PCDN 节点） |

三层计数分开计就是为了定位问题：

| 现象 | 含义 |
| --- | --- |
| gRPC 改写 >0 | **gRPC 层生效**（官方 App 的 playurl 走这条，需要 MitM） |
| 分片 改写 >0 | 分片层生效（明文 http 分片，不需要 MitM） |
| 接口 改写 >0 | 接口层生效（网页版 JSON playurl 走这条） |
| 三层都 0 | 没有任何 B 站流量到达脚本 → 先看面板标题的版本号，再查 MitM |
| 接口 触发 >0、媒体 0 | 接口被触发了但响应体里没有媒体地址（该接口不是 playurl，或接口报错） |
| 有流量、改写 0 | 无需改写（`bad-only` 下的正常状态） |

点卡片右上角刷新按钮 = **立即重测**，不用等 30 分钟的定时任务。面板自身刷新（含自动刷新）只读已存结果，不发请求。

**看 debug 输出。** 先看上面的面板 —— 三层计数与 gRPC 帧结构已经在那里，
最常问的「为什么改写是 0」不用翻日志。要更细的逐条判定，打开 `debug` 后有三处落点：

1. **面板**（不依赖任何设置，永远可用）
2. **请求详情里的注释**：模块的 `[Script]` 行带了 `debug`，Surge 会把 `console.log` 放进该请求的注释。
   到「请求记录」点开对应的 playurl / gRPC / 分片请求即可看到。
3. **日志页面**：需要 `[General] loglevel = info`。该值默认为 `notify`，**脚本输出会被这一级过滤掉**
   （`verbose` 没必要，官方说明它会明显影响性能）。

```
[BiliFastCDN] probe: upos-tf-all-hw.bilivideo.com status=200 251ms 33.42Mbps
[BiliFastCDN] response: https://api.bilibili.com/x/player/playurl bytes=41337 signal=true code=0 rewrites=2 {"force-host":1} target=upos-tf-all-hw.bilivideo.com
[BiliFastCDN]   force-host upos-sz-mirrorcos.bilivideo.com -> upos-tf-all-hw.bilivideo.com
[BiliFastCDN] request: force-host upos-hz-mirrorakam.akamaized.net -> upos-tf-all-hw.bilivideo.com
```

`signal=false` 是「脚本跑到了，但响应体里没有媒体地址」的形态。日志里只有域名、没有签名 query
（`sign` / `deadline` / `oi` 一律不落盘），可以安全贴出来求助。

## 与原项目的差异

| 方面 | bilibili-accelerator | 本项目 |
| --- | --- | --- |
| 运行环境 | 浏览器 userscript | Surge iOS 模块 |
| 拦截点 | 页面 `fetch` / `XHR` / `JSON.parse` | API 响应体改写 + 明文 http 分片改写 |
| 测速时机 | 播放时实时探测 | cron 后台任务 + 面板手动触发 |
| 测速请求 | `fetch`，读满 768KB 后中断 | `$httpClient` + `Range`，恰好 1MB |
| 界面 | 页面浮层面板、速度曲线 | Surge 信息面板（无曲线） |
| 未移植 | — | 速度曲线、沉浸模式 CSS、P2P Guard（WebRTC，Surge 侧无对应手段）、配置桥 |

必须改的原因：Surge 不允许在 http-request 里做异步，也无法用 `fetch` / `ReadableStream`；
把 playurl 响应阻塞几秒比"排名晚几小时"更糟，所以测速被拆到 cron。

## 已知限制

- **官方 App 的 playurl 是 gRPC**（`grpc.biliapi.net`，protobuf）。gRPC 层在**字节层**处理它：不解析 schema，
  递归走一遍 protobuf 结构，把 length-delimited 字段里的 CDN 主机名换掉并同步修正长度前缀。
  安全性质是「没有可换的主机名时输出与输入逐字节相同」，替换后还会重新校验一次能否解析，失败就整段放弃。
- **gRPC 的 body 是帧序列，不是裸 protobuf**：每帧 `1 字节压缩标志 + 4 字节大端长度 + 消息`。
  必须按帧解析 —— 把整段当裸 message 的话第一字节（标志位）就会被判为非法 tag，一次都改不成（这个坑真机踩过：
  `gRPC 触发 13 次 / 改写 0 次`）。
- **gRPC 层的三个边界**：
  ① 压缩帧（标志位非 0，通常是 gzip）替换后无法重新压缩，只能原样保留，`debug` 日志会打 `compressed=N`；
  ② 模块里那条 `max-size` 是缓冲上限，超过就整条跳过直接放行（iOS 上过大会占 NE 进程内存），默认 1MB 偏小，本模块设为 4MB；
  ③ 主机名锚点覆盖 `bilivideo.{com,cn,net}` / `akamaized.net` / 已知 PCDN 家族（`szbdyd.com`、`mountaintoys.cn` 等），
  **裸 IP 形式的 PCDN 节点识别不了**（JSON 层可以，gRPC 层暂时没有）。
- **gRPC 的 pattern 是按方法名收窄的**（`PlayViewUnite` / `PlayView` / `PlayConf` / `PlayURL`）。判定按 body 内容做、
  不按方法名写死，所以 B 站以后再把别的接口迁到 gRPC 时，只需把新方法名加进模块那条 pattern 即可。
- **两条 pattern 不能重叠**：Surge 每个请求只跑第一条匹配的脚本。JSON 那条的 pattern 必须只写 JSON 端点路径
  （`/x/player/*/playurl`、`/pgc/player/*/playurl`、`getRoomPlayInfo`）—— 早期写成 `.*(playurl|...)` 会误匹配
  gRPC 服务名里的 `playurl`，把 protobuf 响应交给按 JSON 处理的脚本。
- **JSC 引擎下缓冲 gRPC body 会占 NE 进程内存**。官方文档明确说 JSC 在 NE 进程内运行、内存占用显著上升，
  可能被系统终止；这也是 Redirect 给这几个条目加 `engine=webview` 的原因（WebView 在独立进程 + 可 JIT）。
  本模块目前用默认引擎并把 `max-size` 限到 4MB；如果观察到卡顿或 NE 内存告警，把 gRPC 条目的 `engine` 改成 `webview`
  是官方推荐的缓解手段（它只是脚本引擎，不是设置界面）。
- **分片层没有 backupUrl 兜底**。接口层改写失败时播放器还能靠 `backupUrl` 换节点；分片层是逐个请求改写，
  目标节点若不可用就是分片失败。所以分片层的策略与接口层一致（`smart` 有排名时才全量改写），
  出问题时可以单独关掉 `mediaRewrite`。
- **直播**（`/live-bvc/`）只做 PCDN 剔除，不做域名替换 —— 那是另一套 CDN 层级，换域名会直接把直播打死。
- **MitM 会解密 `api.bilibili.com`**。若某客户端做了证书校验（出现接口报错、登录异常），把 `[MITM]` 里对应域名去掉即可；模块本身不会失效，只是那些接口不再被改写。
- **签名分片 URL 会过期**。测速样本过期时该轮会退回纯延迟排序（面板会标注"仅延迟测速"）。
- **面板** 依赖 `[Panel]` 段落被 Surge 接受。若卡片一直显示静态文案「点刷新按钮测速」，说明没生效，此时用计数与 `debug` 输出判断。

## 测试

```bash
chrome --headless=new --disable-gpu --allow-file-access-from-files \
       --virtual-time-budget=20000 --dump-dom test/verify.html
```

输出 `ALL n CHECKS PASSED` 或失败明细。覆盖内容：

- **与上游对照**：18 个 URL 的 `classify` 判定与 `rewriteUrlDetail` 改写结果，逐条与参考实现比对（把 `bilibili-accelerator.user.js` 放到 `test/fixtures/` 下即可启用，未放则跳过并标注）
- 五个角色的端到端模拟：接口改写（force / bad-only / 关闭 / 直播 / 空载荷）、gRPC 改写、分片改写、测速（首次引导、样本过期回退、全部失败、结果缓存命中）、面板
- 签名 query 必须逐字节保留；分片改写必须保持原 scheme；日志不得出现 token
- 改写幂等（Surge 会对改写后的 URL 重跑脚本）
- protobuf 改写：等长替换不改动任何长度前缀、变长替换（32→33）精确修正嵌套长度、改写后可重新解析出同样的结构、
  无可换主机／非 protobuf 三种情况一律逐字节原样放行
- gRPC 帧：单帧／多帧都能改写、帧长度按新消息长度重算、压缩帧原样保留并计数、
  截断的帧流不动、**裸 message 不会被误当成帧流**（这条是对真机 `13 次触发 0 次改写` 的回归）
- `$httpClient` 超时必须是秒级（Surge 该 API 的单位是秒，写毫秒会静默挂死 cron）

## 许可证

本项目是 MIT 代码的衍生作品，上游署名与许可全文必须保留 —— 见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
