# 第三方声明 / Third-Party Notices

本项目的核心判定逻辑移植自 **bilibili-accelerator**（MIT 许可）。

另外参考了 **Biliverse/Redirect**（Apache-2.0）的 gRPC 拦截思路 —— 具体为「用 `binary-body-mode` 拿到 Uint8Array
body，并按 gRPC 方法名写 pattern」这一做法。**未复制其代码**：字节级 protobuf 改写器（递归走 message 结构、
替换 length-delimited 字段里的主机名并修正长度前缀）为本项目自行实现。此致谢不构成许可义务，仅作来源说明。

---

## bilibili-accelerator

- 仓库：https://github.com/realzza/bilibili-accelerator
- 作者：realzza
- 许可：MIT License
- 移植时参考的版本：`bilibili-accelerator.user.js` v0.4.1
- 使用的部分：CDN 主机分类判定（PCDN / MCDN 启发式、非默认端口、`os=mcdn`、
  已知 P2P 域名家族、`xy_usource` 调度器回源）、候选节点池、直播 `url_info`
  过滤、`backupUrl` 扇出、force / bad-only 的语义、`/live-bvc/` 排除规则。

```
MIT License

Copyright (c) 2026 realzza

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
