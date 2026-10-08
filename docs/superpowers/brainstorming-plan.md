# vllm-monitor 单文件化 — brainstorming 检查单（Architectural 路径）

> 目标（用户原话）：单文件静态网页、零依赖零包、复制到别处可直接打开、微信移动端点开即看。
> 优化方向（用户全选）：性能/稳定性、功能增强、体验/界面、代码质量。

## 检查单进度

1. ✅ 探索项目上下文（server.mjs / public/ / config.json / monitor.html 遗留物）
2. （Visual Companion — 按需才提，目前无视觉问题）
3. 🔄 澄清问题（逐个问）
   - [x] Q1 优化方向 → 全选 + 硬约束（单文件静态、零依赖、微信可打开）
   - [x] Q2 打开方式 → 纯本地文件 + localStorage（不托管）；内置 gagag/office 默认实例（均无需 key）
   - [ ] 其余设计细节由我定
4. 🔄 提出 2-3 个方案 + 权衡 + 推荐（进行中）
5. ⬜ 分段呈现设计，逐段确认
6. ⬜ 写 spec 到 `docs/superpowers/specs/2026-10-08-vllm-monitor-static-design.md` 并提交（注意：项目非 git 仓库，spec 落地前需确认是否初始化 git）
7. ⬜ spec 自审（占位符/矛盾/歧义/范围）
8. ⬜ 用户审 spec
9. ⬜ 交接 writing-plans

## 已探明的事实（探测证据，2026-10-08）

- **gagag** `<gagag-endpoint>/metrics`：200 + `access-control-allow-origin: *`，预检 OPTIONS 200 + `allow-headers: authorization`。浏览器任意 origin 可直接 fetch。无需 key（匿名 GET 即 200）。
- **office** 真实 metrics URL 是 `<office-endpoint>/vllm/metrics`（200 + CORS `*` + 418 条 vllm: 指标）。**根路径 /metrics 是 404** → 现有 server.mjs 的 `metricsUrlFromBase`（origin+/metrics）对 office 算出的 URL 是错的（潜在 bug）。
- 两个 metrics 端点均**无需 API key**（匿名 200）→ 单文件页面不含任何密钥，无泄密面。
- 微信内置浏览器（X5/WKWebView）同样执行标准 CORS 规则 → CORS 打开后移动端直接可用。
