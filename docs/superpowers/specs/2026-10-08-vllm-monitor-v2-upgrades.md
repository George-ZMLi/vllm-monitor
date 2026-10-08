# vLLM Monitor v2 升级 Spec — 时间窗口 / 双 Y 轴 / 动画 / 缓存命中 / 多模型 / 微信托管

- 日期：2026-10-08
- 分支：`feat/static-single-file`（继续成品分支开发；`main` 保持 legacy 基线不动）
- 关联：`docs/superpowers/specs/2026-10-08-vllm-monitor-static-design.md`（v1 静态单文件 spec）
- 旧版移植来源：`/Users/enterlink_tech/Documents/Default Project/vllm-monitor/monitor.html`（只读参考，不得改动）

## 0. 背景与已拍板决策（用户逐条确认）

| # | 需求 | 决策 |
|---|------|------|
| 1 | 微信打不开本地 .html | 调研确认：微信 X5 内核安全策略禁止执行本地 html（白屏/无反应/显示源码）。**方案 = GitHub Pages 托管 + 微信分享链接**；从 `feat/static-single-file` 分支发布，不合并 |
| 2 | 多模型 endpoint 承接 | 现状核查：全部指标走 `sumSeries`（跨所有 label 组合求和）→ 多模型时数值 = 全模型总和，不崩、语义正确；真实缺陷 = 模型卡片只显示第一个模型名（`distinctLabel(...)[0]`）。**方案 = 聚合 + 显示全部模型名**（不做按模型分 tab） |
| 3 | 数据滚动窗口设置 | 新增设置「数据窗口」[10 / 30 / 60 分钟]，**默认 30 分钟**，持久化 `vllmmon.window` |
| 4 | 线图 X 轴随打开时长持续增长 | X 轴改**实时时钟**：左边界 = max(页面打开时刻, now−窗口)，右边界 = now；窗口攒满前轴一直"拉长"，攒满后转滚动窗口 |
| 5 | 双 Y 轴 | 移植旧版实现：c3 吞吐（generation→右轴 / prompt→左轴·skipZero）、c4 延迟（TTFT p50→右 / E2E p99→左）；左右量程独立（各轴 max×1.15），右轴刻度用系列色着色 |
| 6 | 数字动画 | 移植旧版 `animTo`：350ms easeOutCubic 过渡 + 大跳变（>max(10%, 1)）闪烁高亮 + 断连归"–"，覆盖全部数字卡片 |
| 7 | 缓存命中数据 | 新卡片「缓存命中率」= `vllm:prompt_tokens_cached_total / vllm:prompt_tokens_total`（**累计口径**，0–100%）；指标缺失（prefix caching 未启用）→ 显示"–"；c2 KV% 图加一条命中率线（共享固定 0–100 量程） |
| + | 平滑曲线 | 一并移植旧版 Fritsch–Carlson 单调曲线 + min-max 降采样（单点尖峰不丢失）+ 离散圆点 |

## 1. 时间窗口环形缓冲 + 实时 X 轴

- Store 结构改为：`st = { ts: [], running: [], waiting: [], kv: [], gen: [], prompt: [], ttftP50: [], e2eP99: [] }`（T5 再加 `cacheHit`）。`VALUE_KEYS = ['running','waiting','kv','gen','prompt','ttftP50','e2eP99']`（T5 追加 `'cacheHit'`）。
  - ⚠️ 现有 down 分支 `for (const k of Object.keys(st)) pushRing(st[k], null)` 必须改为遍历 `VALUE_KEYS`，否则 `ts` 数组会被推入 null 污染时间轴。
- 每次 push（up 分支 `snap.ts`；down 分支 `Date.now()`）后执行 `evict(st, nowMs, windowMs)`：`while (st.ts[0] < nowMs - windowMs)` 同时 shift `ts` 与全部值数组（边界：`ts === cut` 保留）。
- `windowMs ∈ {600000, 1800000, 3600000}`，默认 `1800000`；localStorage key `vllmmon.window`（存储值 = 毫秒数字符串）；非法值回落 1800000。
- 头部 `<select id="window">`（10 分钟 / 30 分钟 / 60 分钟），change → 更新 `windowMs` → 持久化 → 对所有实例 store 执行 evict → 全部图表重绘。
- X 映射（纯函数，导出供测试）：
  - `xFrac(ts, t0, t1)` = `d = t1 - t0; d <= 0 ? 1 : clamp((ts - t0) / d, 0, 1)`
  - 绘制时 `t1 = Date.now()`，`t0 = Math.max(st.ts[0] ?? t1, t1 - windowMs)` → 页面打开时间早于窗口时左边界 = 打开时刻（轴持续拉长），否则 = 滚动窗口起点。
- 刻度（纯函数，导出供测试）：
  - `pickTickStep(windowMs)`：从 `[1, 2, 5, 10, 15, 30, 60, 120, 240]`（分钟）取第一个使 `windowMin / step <= 6` 的值（10min→2，30min→5，60min→10，90min→15）。
  - 刻度线**对齐真实时钟**：`first = Math.ceil(t0 / stepMs) * stepMs`，步长 stepMs 至 t1；每刻度 = 3px 短竖线 + HH:MM 标签（`toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })`）。右端保留 `now` 标签；删除固定 `-80m` 标签与 `RING_MAX` 常量。
- 页脚改为：`实例 X · 抓取 url · 每 Ns · 窗口 M 分钟（仅内存）`。

## 2. 双 Y 轴（移植旧版 monitor.html L565–676）

- CHARTS 配置：
  - c3（Token 吞吐）：`generation {axis:'right'}`，`prompt {axis:'left', skipZero:true}`
  - c4（延迟）：`TTFT p50 {axis:'right'}`，`E2E p99 {axis:'left'}`
  - c1 / c2 不变（c2 fixed 100 单轴）
- draw() 移植要点：`hasRight → padR = 46`（否则 10）；各轴量程 = 该轴数据 max × 1.15（下限 0.5；fixed 图用 fixed）；右轴刻度标签用**第一个右轴系列的颜色**着色，绘制于 `w - padR + 6`（textAlign left）。
- `skipZero` 语义（原样移植）：0 值不画点与线但**不断线**（与下一个非 0 点直接连线）。

## 3. 平滑曲线 + min-max 降采样（移植旧版 L572–631、L694–711）

- `drawSmooth(ctx, pts)`：Fritsch–Carlson 单调三次 Hermite，无过冲 —— 原样移植。
- `decimIdx(vals, n, maxPts)`：min-max 桶降采样；`-1` = 全 null 桶（断线标记）—— 原样移植。
- 每系列绘制流程：`decimIdx` 取索引 → null / `-1` 断段 → 每段 `drawSmooth` + 离散圆点（`dotR = n > maxPts ? 1.5 : 2`；`maxPts = Math.max(2, Math.floor(pw / 3))`）。
- `decimIdx` 为纯函数 → 单测覆盖（全 null 桶 → -1；桶内 min/max 顺序；末端点必含；全 null 末尾）。

## 4. 数字卡片动画（移植旧版 L502–556 + L125–126 CSS）

- `NUMCARDS`（id → fmt）：`v-run / v-wait / v-gen / v-prompt / v-succ / v-preem` = `fmtN`；`v-kv` = `v.toFixed(1)`；`v-ttft / v-e2e` = `fmtS`；`v-mem` = `String(Math.round(v))`；`v-spec` = `(v*100).toFixed(1)+'%'`；（T5 追加 `v-cache` = `v.toFixed(1)`）
- `animTo / animLoop / resetCardAnims` 原样移植（350ms easeOutCubic；`|Δ| > max(0.1·max(|target|,|prev|), 1)` 触发 tick 闪烁；rAF 共享单循环；值未变不重启）。
- CSS：`.card .val.tick { animation: valpulse .5s ease; }` + `@keyframes valpulse { 0% { color: var(--accent); } }`（新页 `--accent: #4d7fd6` 已存在，直接引用）。
- 接线：`renderUp` / `refreshActive` 中数字卡片由 `setNum` 改 `animTo`（`v-model` 字符串卡与 `s-*` 副标题仍用 `setNum` / textContent）；`renderDown` → `resetCardAnims()`（全部归"–"）。

## 5. 缓存命中率（新增）

- `buildSnapshot`：
  ```js
  cacheHit: (samples['vllm:prompt_tokens_cached_total'] && g.promptTokens > 0)
    ? Math.min(100, (g.cachedPromptTokens / g.promptTokens) * 100)
    : null
  ```
  指标**缺失**（prefix caching 未启用或旧版 vLLM）必须判 null，不得误报 0%。
- 卡片（full 模式，KV 卡片之后，`lite-hidden`）：`<label>缓存命中</label> <div class="val" id="v-cache">–<small>%</small></div><div class="sub">累计 · cached/prompt tokens</div>`。
- 环形缓冲：`st.cacheHit`（0–100 | null）；c2 图追加系列 `{ label: 'cache_hit', color: '#2aa8a0', key: 'cacheHit', fmt: v => v == null ? '–' : v.toFixed(1) }`（c2 为 fixed 100，单轴即可）。
- `tests/mock-server.mjs` 增加 `vllm:prompt_tokens_cached_total` 计数器（≈ prompt tokens 的 37%，随时间递增）——演示与浏览器验收用，全占位符。

## 6. 多模型（展示层）

- `buildSnapshot`：新增 `models`（`distinctLabel(..., 'model_name')` 全量去重列表）；保留 `model = models[0] ?? null`（兼容既有消费方）。`makeUISnap` 透传 `models`。
- `v-model` 卡片：≤2 个模型 `a · b`；>2 个显示前 2 个 + `+N`；无模型 → `–`。
- 测试连接成功消息：`连接成功：模型 a · b（含 vllm:* 指标 N 条）`。
- 所有数值指标**保持 sumSeries 聚合**（全模型总和），不做按模型拆分。

## 7. 微信 / GitHub Pages（用户执行项）

- 用户操作：repo → Settings → Pages → Deploy from a branch → `feat/static-single-file` / (root)。
- 结果 URL：`https://george-zmli.github.io/vllm-monitor/`（project pages；分支发布不改变 URL）。把链接发手机微信 → X5 内置浏览器直开出数（端点 `ACAO:*` 覆盖任意 https origin，已预检）。
- file:// 路径保持可用（桌面/其他浏览器），两者不冲突。
- README 增加「移动端 / 微信使用（GitHub Pages）」小节：启用步骤 + 链接分享方式 + 配置存于各设备 localStorage 说明。（Pages URL 为 repo 自身公开资产，非机密，可写入 README。）

## 8. 验收标准

1. 测试：`node tests/<file>.mjs` 逐文件直跑（parser / instance / poller / snapshot / ring / chart 六文件）全绿；新增用例：`evict` 边界、`pickTickStep`、`xFrac`、`decimIdx`、`cacheHit`（有/缺指标/prompt=0）、`models`（双模型样本）。
2. 浏览器验收（沿用 v1 R4 替代路径：mock 8931 + 127.0.0.1:8930 http.server）：
   - X 轴：首开刻度从打开时刻持续拉长；窗口切换 10/30/60 立即生效且刷新后持久化；
   - 双轴：c3 / c4 右轴刻度着色、左右量程独立（mock 喂两个量级数据，目视确认小量级系列不再被压缩）；
   - 缓存：c2 出现命中线；卡片 ≈ 37%（mock 基准 ± 漂移）；
   - 动画：数值过渡、大跳变闪烁、断连"–"（mock 停摆验证）；
   - 多模型：mock 第二端点（双 `model_name` label）→ 模型卡 `mock-model-a · mock-model-b`；
   - console 0 错误；网络零外发（仅 mock 域名）；localStorage 含 `vllmmon.window` 往返。
3. 泄漏扫描：既有基准 pattern（`gagag\.top|lmtapi\.enterlink|8a07ebd3|Enter\.link009|vh2hjdoiywe3`）全历史 0 命中；新增内容不含真实端点 / key。
4. 单文件约束：`index.html` 0 外部引用，体积 ≤ ~60KB。
5. 微信真机：用户启用 Pages 后，把链接发手机微信点开自查（v1 §12.4 的验收目标升级为 Pages 链接；file:// 路径不再作为微信验收项）。

## 9. 非目标（本轮不做）

- 按模型分 tab / 拆分；自定义域名；CORS 代理；阈值告警 / 推送；legacy server 版（main 分支）任何改动；interval 之外的其他新设置项（如后续需要另开一轮）。
