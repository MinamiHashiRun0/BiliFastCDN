# BiliFastCDN

Surge iOS 模块：劫持 B 站 `playurl` / 直播 `playinfo` 接口，把视频 CDN 域名重写为**本机实测最快**的节点。

给海外用户看冷门视频时用 —— 那些视频常被调度到 PCDN / 家宽节点，跨境拉流会卡；这个模块把它换到官方 CDN 镜像里测速最快的一个。

---

## 声明

**AI Coding。** 本仓库代码由 AI 助手（Qoder）生成，不是人工逐行编写。核心判定逻辑是在阅读参考实现后**逐条移植**的，而不是重新发明：

- 参考项目：[realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator)（MIT）
- 参考版本：`bilibili-accelerator.user.js` v0.4.1
- 移植范围：CDN 主机分类判定、候选节点池、直播 `url_info` 过滤、`backupUrl` 扇出、force / bad-only 语义、`/live-bvc/` 排除规则、明文 http 分片改写
- 完整署名与上游许可全文：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

**真机验证范围。** 脚本逻辑有 257 项离线断言覆盖（含与上游逐条对照）；模块安装、`[Panel]` 段落、分片层改写已在真机上确认可用。MitM 证书、`cronexp` 触发与各客户端的具体行为仍需自行确认。

## 它做什么

```
Surge（接口层需要 MitM，分片层不需要）
        │
        ├─ 接口层  http-response：解析 playurl / getRoomPlayInfo 的 JSON，
        │          把媒体域名换成排名第一的节点（网页版走这条）
        │
        ├─ 分片层  http-request：改写明文 http 的分片请求
        │          （官方 App 走这条）
        │
        └─ 测速层  cron（默认每 30 分钟检查、结果满 6 小时才重测）：
                   用真实签名分片做 Range 请求测吞吐，排名写入 $persistentStore
```

**为什么需要分片层**：官方 App 的 playurl 走 gRPC（protobuf），接口层碰不到它；但它的分片是**明文 http**，Surge 不做 MitM 也能看到并改写。真机 HAR 显示 App 的分片落在 `upos-hz-mirrorakam.akamaized.net`，把 host 换成测速最快的 `upos-sz-mirroraliov` 后**播放正常** —— URL 上的 `upsig`/`uparams` 校验通过，Akamai 的 `hdnts` token 被忽略。

**视频流不做 MitM。** 分片层处理的是明文 http，接口层只解密那一个 JSON 接口，两者都不让 Surge 参与视频流加解密，4K 不会掉速。

**仍未覆盖**：B站的 P2P 通道（`*.solseed.cn` tracker）不是 HTTP，Surge 无法改写。

## 文件

| 文件 | 说明 |
| --- | --- |
| `BiliFastCDN.sgmodule` | 模块本体：`[Script]` / `[Panel]` / `[MITM]` / 参数表 |
| `bili-cdn.js` | 一个文件四种角色：接口改写 / 分片改写 / 测速 / 面板，按运行上下文分派 |
| `test/verify.html` | 离线验证套件，257 项断言，用浏览器跑 |
| `LICENSE` | MIT |
| `THIRD-PARTY-NOTICES.md` | 上游 realzza/bilibili-accelerator 的 MIT 署名 |

## 配置项

模块参数表里可改（Surge 的模块参数编辑界面）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mode` | `smart` | `smart` 有测速结果时全量改写、无结果时只动劣质节点；`force` 总是改写；`bad-only` 只改写 PCDN / 劣质节点；`off` 关闭改写 |
| `mediaRewrite` | `true` | 是否启用明文 http 分片改写（官方 App 只有这层覆盖得到） |
| `backupFanout` | `true` | 把候选节点写进 `backupUrl`，让播放器自己也能容错切换 |
| `liveFilter` | `true` | 从直播 `url_info` 中剔除 PCDN 节点 |
| `notify` | `true` | 测速完成后发通知 |
| `debug` | `false` | 每次判定写进日志与请求详情注释，且每次改写发一条通知（30 秒内不重复） |

改 `bili-cdn.js` 顶部常量还能调：候选节点池 `CANDIDATE_POOL`（按自己地区增删）、
`DEFAULTS` 里的测速有效期 / 样本有效期 / 探测超时与字节数。测速频率改模块里的 `cronexp`。

## 怎么确认生效

**看面板。** 策略选择页的「B站CDN」卡片：

```
目标 sz-mirroraliov · 72.3 Mbps
测速 1 分钟前 · 8 个节点
接口 触发 12 · 媒体 9 · 改写 27
分片 156 次 · 改写 150 处
最近 全量改写：hz-mirrorakam → sz-mirroraliov
```

两行计数对应两层，分开计就是为了定位问题：

| 现象 | 含义 |
| --- | --- |
| 分片 改写 >0 | **分片层生效**（官方 App 走这条，不需要 MitM） |
| 接口 改写 >0 | 接口层生效（网页版 playurl 走这条，需要 MitM） |
| 接口 触发 0、分片 >0 | App 场景：playurl 是 gRPC 所以接口层看不到，正常 |
| 两层都 0 | 没有任何 B 站流量到达脚本 → 先看面板标题的版本号，再查 MitM |
| 接口 触发 >0、媒体 0 | 接口被触发了但响应体里没有媒体地址（该接口不是 playurl，或接口报错） |
| 有流量、改写 0 | 无需改写（`bad-only` 下的正常状态） |

点卡片右上角刷新按钮 = **立即重测**，不用等 30 分钟的定时任务。面板自身刷新（含自动刷新）只读已存结果，不发请求。

**看 debug 输出。** 打开 `debug` 后有两处落点：

1. **请求详情里的注释**（iOS 上最好找）：模块的 `[Script]` 行带了 `debug`，Surge 会把 `console.log` 放进该请求的注释。
   到「请求记录」点开任意一条 playurl 或分片请求就能看到。
2. **日志页面**：需要 `[General] loglevel = info`。该值默认为 `notify`，脚本输出会被过滤掉
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

- **官方 App 的 playurl 是 gRPC**（`grpc.biliapi.net`，protobuf），接口层解析不了 —— 但 App 的分片是明文 http，
  由分片层覆盖，所以 App 场景实际是生效的（真机已验证）。反过来说：如果某个客户端的 playurl 走 HTTPS（而非明文 http），
  分片层也看不到它，那就只剩接口层可用。
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
- 四个角色的端到端模拟：接口改写（force / bad-only / 关闭 / 直播 / 空载荷）、分片改写、测速（首次引导、样本过期回退、全部失败、结果缓存命中）、面板
- 签名 query 必须逐字节保留；分片改写必须保持原 scheme；日志不得出现 token
- 改写幂等（Surge 会对改写后的 URL 重跑脚本）
- `$httpClient` 超时必须是秒级（Surge 该 API 的单位是秒，写毫秒会静默挂死 cron）

## 许可证

本项目是 MIT 代码的衍生作品，上游署名与许可全文必须保留 —— 见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
