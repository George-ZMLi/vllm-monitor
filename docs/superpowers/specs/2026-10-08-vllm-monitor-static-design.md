# vllm-monitor 单文件静态版 — 设计 Spec

- 日期：2026-10-08
- 分支：`feat/static-single-file`（基线 main = 现有 server 版代码）
- 状态：待用户审阅
- 流程：superpowers brainstorming（Architectural 路径）→ 本 spec → writing-plans

## 1. 背景与目标

现有 vllm-monitor 是"零依赖 Node 服务（server.mjs）+ 静态前端（public/）"：浏览器不能跨域抓
`/metrics` 的时代背景下，用服务端代抓。现已确认两个端点 CORS 全开（见 §2），服务端代抓
不再必要。

**目标**：交付根目录单文件 `index.html`，满足：

1. **零依赖**：无 npm、无 CDN、无外部字体/图片/JS，全部内联
2. **随处可开**：`file://` 直接打开可用；微信内置浏览器（X5/WKWebView）点开即用
3. **浏览器直连**：数据由页面直接 fetch 用户自己的 vLLM `/metrics`，不经过任何代理
4. **仓库零端点零密钥**：repo（含 README、spec、所有跟踪文件）不出现任何真实
   baseURL/API key；用户接触 repo 后填自己的端点与 key 即可看自己的 vLLM
5. **双模式**：精简（lite，移动优先）/ 完整（full，桌面优先），同一数据管线上的两个
   展示过滤器

## 2. 已探明的事实（2026-10-08 实测，端点以 A/B 指代，不写入 URL）

| 事实 | 证据 |
|---|---|
| vLLM `/metrics` 不需要 API key | A、B 匿名 GET 均 200。机制：vLLM `--api-key` 只保护 OpenAI 兼容 API 路由，`/metrics` 不在其鉴权中间件内；B 的网关只对聊天路径加鉴权 |
| A 端点 CORS 全开 | `ACAO: *`，OPTIONS 预检 200 + `allow-headers: authorization` |
| B 端点 CORS 全开 | nginx 反射 Origin + `allow-credentials: true`，预检 200 |
| B 的真实 metrics 路径非根路径 | B 的 origin 根 `/metrics` 返回 404，真实路径在其网关的 vLLM 前缀下（形如 `<origin>/<prefix>/metrics`）→ **现有 server.mjs 的 `metricsUrlFromBase`（origin + /metrics）对 B 类端点是错的**（潜伏 bug，B 在旧面板里一直是抓取失败） |
| B 的 metrics 体量 | 单次响应 ≈58KB，418 条 `vllm:` 指标行 |
| 微信内置浏览器 | 执行标准 CORS 规则，CORS 打开后移动端直连合法 |

## 3. 硬约束

- 交付物 = 仓库根目录一个 `index.html`；内联 `<style>` + `<script>`，**零外部请求**
- 仓库内（含 spec/README）不得出现真实端点 URL 或 API key，占位一律 `https://your-vllm.example.com/v1`
- **不使用任何公共 CORS 代理**（monitor.html 遗留的 allorigins 方案作废：会把用户 key/URL 泄漏给第三方；CORS 已开，无必要）
- 本分支不修改 `server.mjs`、`public/`、`config.json.example`（server 版保持可用）
- 用户数据只存本机 localStorage；页面不向任何第三方发请求（除用户自己填的端点）

## 4. 总体架构

单文件内部结构（IIFE，从上到下）：

1. **Prometheus 文本解析器** — 从 server.mjs 原样移植（行解析、标签、直方图桶 p50/p99 插值）
2. **buildSnapshot** — 原样移植（字段见 §6）
3. **实例仓库** — 无内置种子 + localStorage（§5）
4. **抓取循环** — 每实例链式抓取 + 超时 + 退避 + 隐藏暂停（§7）
5. **渲染层** — 12 卡 + 4 图 DOM 只建一份；模式 = `body` class 切换（§8）
6. **UI** — 实例增删弹窗 + 测试连接、模式切换、间隔切换、断连 banner

**核心原则（双模式复杂度控制）**：lite/full 不是两套实现，是同一数据管线上的两个
"展示过滤器"。卡片/图表 DOM 唯一，模式只决定 CSS 显隐与布局；数据、轮询、状态机 100% 共享。

## 5. 实例管理与配置

- **首开状态**：localStorage 空 → 空实例列表 + 欢迎态（醒目"添加你的 vLLM 实例"入口）。
  文件出厂不含任何端点。
- **localStorage keys**：
  - `vllmmon.targets` — 实例数组（§5 字段）
  - `vllmmon.active` — 当前选中实例 id
  - `vllmmon.mode` — `"lite" | "full"`
  - `vllmmon.interval` — `"1" | "2" | "5"`（秒）
- **每实例字段**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✓ | 显示名 |
| `baseURL` | ✓ | OpenAI 兼容 base（如 `https://your-vllm.example.com/v1`） |
| `metricsPath` | 可选 | 空 = 自动推断 `origin + /metrics`；推断 404 时诊断提示"请指定 metricsPath（如 /vllm/metrics）" |
| `apiKey` | 可选 | 仅存本机 localStorage；填写后以 `Authorization: Bearer` 头附在该实例的 metrics 抓取上（端点不要求 key 时无副作用；端点保护 metrics 时必需） |
| `enabled` | 可选（默认 true） | 每实例轮询开关：关 = 停轮询、状态点置灰，不删除 |

**metrics URL 计算**：`new URL(baseURL).origin + (metricsPath || '/metrics')`
（baseURL 只用来取 origin；metricsPath 以 `/` 开头，直接拼在 origin 后）

- **测试连接**：添加/编辑实例后单次 fetch 诊断 —— 成功（回显模型名 + 是否含 `vllm:*`
  指标）/ HTTP 4xx（404 → 提示 metricsPath；401/403 → 提示补 key）/ CORS 被拦 / 超时 / 网络不通

## 6. 数据模型（自 server.mjs 移植，保持同构）

**Snapshot**：

```
gauges:  running, waiting, kvPct, preemptions, promptTokens,
         generationTokens, cachedPromptTokens, residentMb
successByReason: { [finished_reason]: count }
successTotal
specDecode: { drafts, accepted, acceptRate } | null   // 无投机解码时 null
hist: { time_to_first_token_seconds | inter_token_latency_seconds |
        e2e_request_latency_seconds | request_queue_time_seconds |
        request_prefill_time_seconds | request_decode_time_seconds }
        → 各 { count, avg, p50, p99 }
model: string | null
engines: string[]
```

**速率**（`rates`）：每实例保留最近 2 次抓取的 4 个累计计数器
（prompt/generation/success/preemptions），差值 ÷ 间隔秒数；
`a < b`（计数器重置）→ 该速率 null，显示 "–"。

**前端环形缓冲**：每实例 7 序列（running/waiting/kv/gen/prompt/ttftP50/e2eP99），
各 2400 点（1s 间隔 ≈40 分钟，2s ≈80 分钟，5s ≈4 小时）。

## 7. 抓取循环与稳定性

- **链式抓取**（移植 server.mjs 策略）：每实例单请求不重叠，`等待 = 间隔 − 本次耗时`；
  远端变慢自动顺延，不堆叠并发
- **超时**：单次 fetch 8s（AbortController）；请求带固定非空 UA（防网关 WAF 拦空 UA）
- **失败处理**：实例状态点变红 + 顶部断连 banner（"实例 X 已断连，N s 后重试"）；
  失败期间该实例退避到 5s 重试（若当前常规间隔 ≥5s 则维持常规间隔），成功一次恢复常规间隔
- **`visibilitychange`**：页面隐藏（微信切后台）→ 停全部轮询；可见 → 下一拍自动继续
  （不补数据）
- **间隔**：全局 {1s, 2s, 5s}，默认 2s，持久化

## 8. 双模式视图与移动端布局

- **切换机制**：`body.mode-lite` / `body.mode-full` 单 class 切换，纯 CSS 显隐 + 排布，
  零重复逻辑
- **默认值**：首次打开按视口宽度自动选（<640px → lite，否则 full）；之后以
  localStorage 中的手动选择为准（横竖屏旋转不乱跳）

**Lite（精简，移动优先）**，自上而下：

1. 吸顶条：实例 pills（横向滑动、状态点：绿正常/红断连/灰暂停）+ 间隔切换
2. 核心卡片行（横向滑动，大字号）6 张：运行中 / 排队 / KV 缓存% / 生成速度 tok/s /
   TTFT p50 / E2E p99
3. 2 张 canvas 图（高 220px，横轴相对时间 "-X 分"）：Token 吞吐（generation+prompt）、
   延迟（TTFT p50 + E2E p99）
4. 底部条：实例管理（增删/测试）+ "切到完整模式"

**Full（完整，桌面优先）**：等同现有桌面体验 —— 12 卡（运行/排队/KV/生成速度/
预填充速度/TTFT p50/E2E p99/成功请求/抢占/内存/模型 + 条件显示的投机解码接受率）
网格 + 4 图（请求数量/KV 使用率/Token 吞吐/延迟）+ 实例标签页 + 间隔切换；
窄屏下单列排布。

**移动端交互**：触控目标 ≥44px；卡片 KV 高负载变色沿用（≥70% 橙、≥90% 红）。

## 9. 性能

- 页面加载 0 外部请求；运行时仅 fetch 用户自己的端点
- canvas 按 `devicePixelRatio` 缩放（上限 2x）；仅新数据点到达时重绘，无逐帧动画
- DOM 更新走缓存元素 `textContent`，每拍一次批量写（沿用现有 setNum 模式）
- 环形缓冲 `shift()` O(1)
- 流量参考：B 端点单次 ≈58KB，2s 间隔双实例 ≈140KB/分钟；嫌多切 5s；后台挂着 0 流量（隐藏即停）

## 10. 迁移与清理（均在 feat 分支；main 基线与原始目录不动）

| 对象 | 处置 |
|---|---|
| 新 `index.html`（根目录） | 新增，本开发主体 |
| `README.md` | 新增：单文件用法（打开→添加端点→手机用法）、server 版用法、"为什么 metrics 通常不需要 key"、GitHub 推送步骤 |
| `monitor.html` | **本分支删除**（遗留单文件，含公共代理方案，被新 index.html 取代） |
| `server.mjs` / `public/` / `config.json.example` | 保留不动（server 版仍可用） |
| 本 spec + `docs/superpowers/brainstorming-plan.md` | 提交在 feat 分支（已 sanitize，无真实 URL） |
| 原始 `Documents/Default Project/vllm-monitor` | 一个字节不动 |
| GitHub 推送（用户建 repo 后） | `git remote add origin <url>`；推 main + feat/static-single-file |

## 11. 不在范围（YAGNI）

- 任何公共/自建 CORS 代理或服务端代抓
- 历史持久化（跨页面重载保留曲线）
- 告警推送（webhook/微信机器人/邮件）
- 多用户、鉴权、托管部署（用户可自行托管，不在本次）
- 第三种视图模式、深色模式、主题定制
- WebSocket/SSE（vLLM 不提供）

## 12. 验收标准

1. **file:// 首开**：空态 + 添加入口；填端点后 5s 内数据到达，卡片/图持续刷新
2. **手机（微信）**：lite 模式 6 卡 + 2 图；切后台轮询停止（DevTools/流量可见），回前台自动续
3. **metricsPath 诊断**：端点 B 不填 metricsPath → 404 诊断明确提示指定路径；填上后正常
4. **零泄漏**：`git grep` 全部跟踪文件，真实端点/密钥 0 命中；DevTools 网络面板除用户端点外 0 请求
5. **单文件 < 80KB**；无外部资源引用（grep `src=`/`href=http`/`@import` 验证）
6. **旧版可用**：`git checkout main && node server.mjs` 正常运行（main 基线已 sanitize：
   首开无默认实例，需在界面/`config.json` 里添加自己的端点；除该 sanitization 外无行为回归）
