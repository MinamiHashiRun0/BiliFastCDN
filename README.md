# BiliFastCDN

Surge iOS 模块：劫持 B 站 `playurl` / 直播 `playinfo` 接口，把视频 CDN 域名重写为**本机实测最快**的节点。

给海外用户看冷门视频时用 —— 那些视频常被调度到 PCDN / 家宽节点，跨境拉流会卡；这个模块把它换到官方 CDN 镜像里测速最快的一个。

---

## 声明

**AI Coding。** 本仓库代码由 AI 助手（Qoder）生成，不是人工逐行编写。核心判定逻辑是在阅读参考实现后**逐条移植**的，而不是重新发明：

- 参考项目：[realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator)（MIT）
- 参考版本：`bilibili-accelerator.user.js` v0.4.1
- 移植范围：CDN 主机分类判定、候选节点池、直播 `url_info` 过滤、`backupUrl` 扇出、force / bad-only 语义、`/live-bvc/` 排除规则
- 完整署名与上游许可全文：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

**未在真机验证。** 脚本逻辑有 228 项离线断言覆盖（含与上游逐条对照），但模块安装、MitM 证书、`cronexp` 触发、`[Panel]` 段落是否被 Surge 接受，都只有在设备上才能确认。使用前请自行审阅。

---

## 它做什么

```
Surge MitM（只覆盖 API 域名）
        │
        ├─ 改写层  http-response：解析 playurl / getRoomPlayInfo 的 JSON，
        │          把媒体域名换成排名第一的节点
        │
        └─ 测速层  cron（默认每 30 分钟检查、结果满 6 小时才重测）：
                   用真实签名分片做 Range 请求测吞吐，排名写入 $persistentStore
```

**视频流本身不在 MitM 列表里。** 只有那一个 JSON 接口被解密改写，播放器仍按改写后的地址直接拉流，4K 不会因为 MitM 掉速。

## 文件

| 文件 | 说明 |
| --- | --- |
| `BiliFastCDN.sgmodule` | 模块本体：`[Script]` / `[Panel]` / `[MITM]` / 参数表 |
| `bili-cdn.js` | 一个文件三种角色：改写 / 测速 / 面板，按运行上下文分派 |
| `test/verify.html` | 离线验证套件，228 项断言，用浏览器跑 |
| `LICENSE` | MIT（**把 `<你的名字>` 换成你自己**） |
| `THIRD-PARTY-NOTICES.md` | 上游 realzza/bilibili-accelerator 的 MIT 署名 |

## 安装（iOS）

1. 把 `BiliFastCDN.sgmodule` 和 `bili-cdn.js` 放进 Surge 的目录
   （用 Files App 进入「我的 iPhone → Surge」放入）。
   > 也可以远端分发：把 `bili-cdn.js` 上传后，把模块里三处 `script-path` 换成完整 URL。
2. 在 Surge 的「模块」里安装并启用 `BiliFastCDN`。
   文件放对目录后应出现在本地模块列表中；若列表里没有，改用「从 URL 安装」并指向你托管的那两个文件。
3. Surge → 首页 → 打开 **MitM** 总开关，并安装 / 信任证书。
   没有 MitM，脚本不会执行，本模块等同于没开。
4. 打开策略选择页，应该能看到「B站CDN」面板卡片。

## 配置项

模块参数表里可改（Surge 的模块参数编辑界面）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mode` | `smart` | `smart` 有测速结果时全量改写、无结果时只动劣质节点；`force` 总是改写；`bad-only` 只改写 PCDN / 劣质节点；`off` 关闭改写 |
| `backupFanout` | `true` | 把候选节点写进 `backupUrl`，让播放器自己也能容错切换 |
| `liveFilter` | `true` | 从直播 `url_info` 中剔除 PCDN 节点 |
| `notify` | `true` | 测速完成后发通知 |
| `debug` | `false` | 每次判定写进 Surge 日志，且每次改写发一条通知（30 秒内不重复） |

改 `bili-cdn.js` 顶部常量还能调：候选节点池 `CANDIDATE_POOL`（按自己地区增删）、
`DEFAULTS` 里的测速有效期 / 样本有效期 / 探测超时与字节数。测速频率改模块里的 `cronexp`。

## 怎么确认生效了

**看面板。** 策略选择页的「B站CDN」卡片：

```
目标 tf-all-hw · 41.9 Mbps
测速 12 分钟前 · 8 个节点
命中 9 次 · 改写 27 处 · 直播剔除 3
最近 全量改写：sz-mirrorcos → tf-all-hw
```

| 现象 | 含义 |
| --- | --- |
| 命中 0 次 | 没收到 playurl 流量 → 检查 MitM 总开关和证书 |
| 命中 >0、改写 0 处 | 流量到了，但 B 站自己选的节点本来就合格（`bad-only` 下的正常状态） |
| 改写 >0 处 | 生效了 |

点卡片右上角刷新按钮 = **立即重测**，不用等 30 分钟的定时任务。面板自身刷新（含自动刷新）只读已存结果，不发请求。

**看日志。** 打开 `debug` 后：

```
[BiliFastCDN] probe: upos-tf-all-hw.bilivideo.com status=200 251ms 33.42Mbps
[BiliFastCDN] response: https://api.bilibili.com/x/player/playurl rewrites=2 {"force-host":1} target=upos-tf-all-hw.bilivideo.com
[BiliFastCDN]   force-host upos-sz-mirrorcos.bilivideo.com -> upos-tf-all-hw.bilivideo.com
```

日志里只有域名、没有签名 query（`sign` / `deadline` / `oi` 一律不落盘），可以安全贴出来求助。

## 与原项目的差异

| 方面 | bilibili-accelerator | 本项目 |
| --- | --- | --- |
| 运行环境 | 浏览器 userscript | Surge iOS 模块 |
| 拦截点 | 页面 `fetch` / `XHR` / `JSON.parse` | API 响应体改写（对任意 App 生效，不限浏览器） |
| 测速时机 | 播放时实时探测 | cron 后台任务 + 面板手动触发 |
| 测速请求 | `fetch`，读满 768KB 后中断 | `$httpClient` + `Range`，恰好 1MB |
| 界面 | 页面浮层面板、速度曲线 | Surge 信息面板（无曲线） |
| 未移植 | — | 速度曲线、沉浸模式 CSS、P2P Guard（WebRTC）、配置桥 |

必须改的原因：Surge 不允许在 http-request 里做异步，也无法用 `fetch` / `ReadableStream`；
把 playurl 响应阻塞几秒比"排名晚几小时"更糟，所以测速被拆到 cron。

## 已知限制

- **官方客户端 gRPC 接口**（`grpc.biliapi.net`）是 protobuf，脚本无法解析，因此只覆盖 HTTP 接口；App 内部分流量可能仍走原始节点。
- **直播**（`/live-bvc/`）只做 PCDN 剔除，不做域名替换 —— 那是另一套 CDN 层级，换域名会直接把直播打死。
- **MitM 会解密 `api.bilibili.com`**。若某客户端做了证书校验（出现接口报错、登录异常），把 `[MITM]` 里对应域名去掉即可；模块本身不会失效，只是那些接口不再被改写。
- **签名分片 URL 会过期**。测速样本过期时该轮会退回纯延迟排序（面板会标注"仅延迟测速"）。
- **面板** 依赖 `[Panel]` 段落被 Surge 接受。若卡片一直显示静态文案「点刷新按钮测速」，说明没生效，此时用日志 / `debug` 判断。

## 测试

```bash
chrome --headless=new --disable-gpu --allow-file-access-from-files \
       --virtual-time-budget=20000 --dump-dom test/verify.html
```

输出 `ALL n CHECKS PASSED` 或失败明细。覆盖内容：

- **与上游对照**：18 个 URL 的 `classify` 判定与 `rewriteUrlDetail` 改写结果，逐条与参考实现比对（把 `bilibili-accelerator.user.js` 放到 `test/fixtures/` 下即可启用，未放则跳过并标注）
- 两个角色的端到端模拟：改写（force / bad-only / 关闭 / 直播 / 空载荷）、测速（首次引导、样本过期回退、全部失败、结果缓存命中）
- 签名 query 必须逐字节保留；日志不得出现 token
- 面板三种状态、debug 开关与通知限流
- `$httpClient` 超时必须是秒级（Surge 该 API 的单位是秒，写毫秒会静默挂死 cron）

## 许可证

**建议 MIT**，理由：

1. 本项目是 MIT 代码的衍生作品，**上游署名与许可全文必须保留**（这是唯一的硬约束，与选哪个许可无关）—— 见 `THIRD-PARTY-NOTICES.md`。
2. 与上游同许可，组合作品最干净，别人拿去改也能直接用。
3. Apache-2.0 同样兼容，额外附带专利授权，代价是多一套 NOTICE 机制；如果在意专利可选它。
4. GPL 系虽然对 MIT 部分兼容，但会把整个组合作品拖入 copyleft，对一个 Surge 模块来说通常是给自己添麻烦。

当前 `LICENSE` 是 MIT 占位版本，**请把 `<你的名字>` 换成你自己的名字或 ID**。
