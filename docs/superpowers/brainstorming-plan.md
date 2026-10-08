# vllm-monitor 单文件化 — brainstorming 检查单（Architectural 路径）

> 目标（用户原话）：单文件静态网页、零依赖零包、复制到别处可直接打开、微信移动端点开即看。
> 优化方向（用户全选）：性能/稳定性、功能增强、体验/界面、代码质量。

## 检查单进度

1. ✅ 探索项目上下文（server.mjs / public/ / config.json / monitor.html 遗留物）
2. （Visual Companion — 按需才提，目前无视觉问题）
3. ✅ 澄清问题：Q1 优化方向（全选+硬约束）；Q2 打开方式（纯本地+localStorage）；Q3 仓库零端点零密钥（已 sanitization，0 残留）
4. ✅ 方案对比 → 用户选定 **方案 3：双模式（精简/完整）单文件**
5. ✅ 分段设计（4 段全部逐段确认）：① 架构/管线/双模式原则 ② 实例管理（无内置 URL 种子） ③ 双模式视图与移动布局 ④ 性能/稳定性+迁移清理
6. ✅ spec 落盘并提交（d99f954）：`docs/superpowers/specs/2026-10-08-vllm-monitor-static-design.md`
7. ✅ spec 自审（修 4 处：metrics URL 公式 / apiKey 附着 / 退避边界 / main 基线措辞）
8. ✅ 用户审 spec（通过："没问题，出实施计划"）
9. 🔄 交接 writing-plans：实施计划已写 `docs/superpowers/plans/2026-10-08-static-single-file-monitor.md`（7 任务 TDD，零依赖测试脚手架 + mock server）；自审修 3 处（冻结时钟、schedule 注入契约、no-burst 测试句柄 bug）；待用户审计划 + 选执行方式（native / subagent-driven）

**git 工作区**：仓库 `/Users/enterlink_tech/Enter-Link/Project/George/vllm-monitor`；main@3db5aaf=已 sanitize 基线；开发分支 `feat/static-single-file`；原始 `Documents/Default Project/vllm-monitor` 未动；用户稍后自建 GitHub repo 供 push

## 已探明的事实（探测证据，2026-10-08）

- **gagag** `<gagag-endpoint>/metrics`：200 + `access-control-allow-origin: *`，预检 OPTIONS 200 + `allow-headers: authorization`。浏览器任意 origin 可直接 fetch。无需 key（匿名 GET 即 200）。
- **office** 真实 metrics URL 是 `<office-endpoint>/vllm/metrics`（200 + CORS `*` + 418 条 vllm: 指标）。**根路径 /metrics 是 404** → 现有 server.mjs 的 `metricsUrlFromBase`（origin+/metrics）对 office 算出的 URL 是错的（潜在 bug）。
- 两个 metrics 端点均**无需 API key**（匿名 200）→ 单文件页面不含任何密钥，无泄密面。
- 微信内置浏览器（X5/WKWebView）同样执行标准 CORS 规则 → CORS 打开后移动端直接可用。
