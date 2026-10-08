# vllm-monitor 单文件静态版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建零依赖单文件 `index.html`（双模式 vLLM 实时监控页，浏览器直连 `/metrics`）。

**Architecture:** 单文件 IIFE，内部顺序：常量 → Prometheus 解析器 → 快照/速率 → 实例模型/持久化 → 抓取循环 → 诊断 →（DOM）boot/渲染/UI。双模式 = 同一数据管线上的两个 CSS 展示过滤器（`body.mode-lite` / `body.mode-full`，DOM 只建一份）。纯逻辑以具名函数存在，脚本尾部 Node 测试钩子导出，测试用 `node:vm` 从 HTML 中提取脚本执行——全程零 npm 依赖。

**Tech Stack:** 纯浏览器 JS（内联 IIFE，ES2020+）、canvas 2D、localStorage；测试用 Node 内置 `node:vm` / `node:assert` / `node:http`（mock server），无 npm 包。

**Spec:** `docs/superpowers/specs/2026-10-08-vllm-monitor-static-design.md`

## Global Constraints

- `index.html` 为唯一交付物：恰好**一个**内联 `<script>`（测试钩子靠提取它）、内联 `<style>`、**0 外部请求**（验证：`grep -nE 'src=|href="http|@import|url\(http' index.html` 必须 0 命中）
- 仓库（含本计划、README、测试）不得出现真实端点 URL / API key；占位一律 `https://your-vllm.example.com/v1`，测试只用 `127.0.0.1` mock
- 脚本顶层语句禁止触碰 DOM / localStorage（保证 Node 可测）；DOM 访问只在 `boot()` 与事件处理器内
- 脚本尾部固定两行钩子：
  `if (typeof module !== 'undefined' && module.exports) module.exports = { ...具名核心函数... };`
  `if (typeof document !== 'undefined' && typeof boot === 'function' && document.getElementById) boot();`
- localStorage keys：`vllmmon.targets` / `vllmmon.active` / `vllmmon.mode` / `vllmmon.interval`
- 常量固定值：`RING_MAX = 2400`、`INTERVALS = [1000, 2000, 5000]`、默认间隔 `2000`、`FETCH_TIMEOUT_MS = 8000`、`BACKOFF_MS = 5000`、`MODE_MIN_WIDTH = 640`、canvas DPR 上限 `2`
- `index.html` 最终 < 80KB
- 本分支不修改 `server.mjs` / `public/` / `config.json.example`；main 分支不动
- metrics URL 计算：`new URL(baseURL).origin + (metricsPath || '/metrics')`
- 每任务结束以 commit 收尾（`feat:` / `test:` / `docs:` / `chore:` 前缀）

## Review Focus

1. **file:// 下浏览器禁用 localStorage**（部分浏览器安全策略）→ 页面仍可用、提示"本地设置无法保存"、不崩。测试钉在 **Task 3**（throwing storage 的 loadTargets/saveTargets）
2. **用户填的 baseURL 其 origin/metrics 为 404**（vLLM 挂在网关前缀下）→ 诊断明确提示"请指定 metricsPath（如 /vllm/metrics）"。测试钉在 **Task 3**（classifyFailure(404)）+ Task 6 手工验证
3. **页面开着时 vLLM 重启（计数器回退）** → 速率显示 "–"（null），绝不出现负数尖峰。测试钉在 **Task 2**（computeRates a<b → null）
4. **某端点宕机/断网** → 该实例退避 5s + banner，**不影响其他实例的调度**。测试钉在 **Task 4**（隔离测试）
5. **页面在微信后台挂几小时** → 隐藏时零定时器；恢复后每实例恰好 1 个在途请求、无补发爆发。测试钉在 **Task 4**（start/stop 无爆发测试）

---

### Task 1: 测试脚手架 + Prometheus 解析器

**Files:**
- Create: `index.html`（初始骨架 + 解析器核心段 + 尾部钩子）
- Create: `tests/helpers.mjs`
- Create: `tests/parser.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `parseProm(text) -> samples`（`{ metricName: [{labels, value}] }`）、`sumSeries(samples, name) -> number|null`、`histogram(samples, base) -> { buckets: [le,count][], count, sum, avg }`、`percentile(buckets, count, q) -> number|null`

- [ ] **Step 1: 写测试脚手架 `tests/helpers.mjs`**

```js
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadCore() {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('index.html 缺少内联 <script>');
  const module = { exports: {} };
  const ctx = vm.createContext({ module, console, setTimeout, clearTimeout, URL, AbortController });
  vm.runInContext(m[1], ctx, { filename: 'index.html#inline' });
  return module.exports;
}

export function test(name, fn) {
  const r = fn();
  if (r && typeof r.then === 'function')
    r.then(() => console.log('  ok -', name), (e) => { console.error('  FAIL -', name, e); process.exitCode = 1; });
  else console.log('  ok -', name);
}
export const flush = () => new Promise((r) => setTimeout(r, 20));
```

- [ ] **Step 2: 写失败测试 `tests/parser.test.mjs`**

```js
import assert from 'node:assert/strict';
import { loadCore, test } from './helpers.mjs';

const FIX = `# HELP t_a_seconds x
# TYPE t_a_seconds histogram
t_a_seconds_bucket{le="0.5"} 10
t_a_seconds_bucket{le="1"} 18
t_a_seconds_bucket{le="+Inf"} 20
t_a_seconds_sum 12.5
t_a_seconds_count 20
vllm:num_requests_running{model_name="m1", engine="0"} 3
vllm:num_requests_running{model_name="m1", engine="1"} 1
vllm:num_requests_waiting{model_name="m1"} 2
vllm:prompt_tokens_total 1000
not_a_number abc`;

const { parseProm, sumSeries, histogram, percentile } = loadCore();

test('parseProm: 跳过注释/非法行，解析标签', () => {
  const s = parseProm(FIX);
  assert.equal(s['vllm:num_requests_running'].length, 2);
  assert.deepEqual(s['vllm:num_requests_running'][0].labels, { model_name: 'm1', engine: '0' });
  assert.equal(s['not_a_number'], undefined);
});
test('sumSeries: 多标签求和 / 缺失返回 null', () => {
  const s = parseProm(FIX);
  assert.equal(sumSeries(s, 'vllm:num_requests_running'), 4);
  assert.equal(sumSeries(s, 'nope'), null);
});
test('histogram + percentile: 桶/计数/均值/插值', () => {
  const s = parseProm(FIX);
  const h = histogram(s, 't_a_seconds');
  assert.deepEqual(h.buckets, [[0.5, 10], [1, 18], [Infinity, 20]]);
  assert.equal(h.count, 20);
  assert.equal(h.avg, 0.625);
  assert.equal(percentile(h.buckets, 20, 0.5), 0.5);
  assert.equal(percentile(h.buckets, 20, 0.99), null); // target 落入 +Inf 桶 → null（移植行为）
  assert.equal(percentile([], 0, 0.5), null);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `node tests/parser.test.mjs`
Expected: 报错（index.html 不存在或无导出）

- [ ] **Step 4: 实现 — 创建 `index.html` 骨架 + 解析器核心段**

`index.html`：`<!doctype html>` + 中文标题 + 空 `<style>` + 一个 `<script>`。脚本内按序放：`parseLabels`、`parseProm`、`sumSeries`、`histogram`、`percentile` —— 从 `server.mjs:38-100` **原样拷贝**（行为基准，勿改算法），然后尾部加 Global Constraints 规定的两行钩子（exports 含这 5 个函数）。

- [ ] **Step 5: 运行确认通过**

Run: `node tests/parser.test.mjs`
Expected: 3 行 `ok`，退出码 0

- [ ] **Step 6: Commit**

```bash
git add index.html tests/helpers.mjs tests/parser.test.mjs
git commit -m "feat: single-file core — prometheus parser + zero-dep test harness"
```

---

### Task 2: 快照构建 + 实时速率

**Files:**
- Modify: `index.html`（核心段追加）
- Create: `tests/snapshot.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `parseProm` / `sumSeries` / `histogram` / `percentile`
- Produces: `HISTS`（6 个名字数组）、`buildSnapshot(samples) -> { model, engines, gauges, successByReason, successTotal, specDecode, hist }`、`computeRates(history) -> { promptTokensPerS, generationTokensPerS, requestsPerS, preemptionsPerS } | null`（history 元素 `{ ts, c: { prompt, generation, success, preemptions } }`，需 ≥2 且 ts 不同；任一计数器回退 → 对应速率 null）

- [ ] **Step 1: 写失败测试 `tests/snapshot.test.mjs`**

```js
import assert from 'node:assert/strict';
import { loadCore, test } from './helpers.mjs';

const { parseProm, buildSnapshot, computeRates } = loadCore();

const FIX = `vllm:num_requests_running{model_name="m1", engine="0"} 3
vllm:num_requests_running{model_name="m1", engine="1"} 1
vllm:num_requests_waiting{model_name="m1"} 2
vllm:kv_cache_usage_perc 0.42
vllm:num_preemptions_total 5
vllm:prompt_tokens_total 1000
vllm:generation_tokens_total 2000
vllm:prompt_tokens_cached_total 300
vllm:request_success_total{finished_reason="stop"} 41
vllm:request_success_total{finished_reason="length"} 4
vllm:time_to_first_token_seconds_bucket{le="0.5"} 200
vllm:time_to_first_token_seconds_bucket{le="1"} 600
vllm:time_to_first_token_seconds_bucket{le="2"} 995
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 1000
vllm:time_to_first_token_seconds_sum 1500
vllm:time_to_first_token_seconds_count 1000
process_resident_memory_bytes 2147483648`;

test('buildSnapshot: gauge/成功分布/直方图/模型', () => {
  const s = buildSnapshot(parseProm(FIX));
  assert.equal(s.gauges.running, 4);
  assert.equal(s.gauges.waiting, 2);
  assert.equal(s.gauges.kvPct, 0.42);
  assert.equal(s.gauges.residentMb, 2048);
  assert.deepEqual(s.successByReason, { stop: 41, length: 4 });
  assert.equal(s.successTotal, 45);
  assert.equal(s.model, 'm1');
  assert.deepEqual(s.engines, ['0', '1']);
  assert.equal(s.specDecode, null);
  const h = s.hist['time_to_first_token_seconds'];
  assert.equal(h.count, 1000);
  assert.equal(h.avg, 1.5);
  assert.equal(h.p50, 0.875);
  assert.ok(Math.abs(h.p99 - 1.9873417721) < 1e-6); // 990/395 插值
  const empty = s.hist['inter_token_latency_seconds'];
  assert.deepEqual(empty, { count: 0, avg: null, p50: null, p99: null });
});
test('buildSnapshot: 投机解码存在时解析', () => {
  const s = buildSnapshot(parseProm(FIX + `
vllm:spec_decode_num_draft_tokens_total 100
vllm:spec_decode_num_accepted_tokens_total 80`));
  assert.deepEqual(s.specDecode, { drafts: 100, accepted: 80, acceptRate: 0.8 });
});
test('computeRates: 正常差值 / 计数器回退 null / 单条 null / 同 ts null', () => {
  const r = computeRates([
    { ts: 0, c: { prompt: 100, generation: 1000, success: 10, preemptions: 1 } },
    { ts: 2000, c: { prompt: 130, generation: 500, success: 12, preemptions: 1 } },
  ]);
  assert.equal(r.promptTokensPerS, 15);
  assert.equal(r.generationTokensPerS, null); // 1000 → 500 回退（Review Focus #3）
  assert.equal(r.requestsPerS, 1);
  assert.equal(r.preemptionsPerS, 0);
  assert.equal(computeRates([{ ts: 0, c: {} }]), null);
  assert.equal(computeRates([
    { ts: 5, c: { prompt: 1, generation: 1, success: 1, preemptions: 1 } },
    { ts: 5, c: { prompt: 2, generation: 2, success: 2, preemptions: 2 } },
  ]), null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/snapshot.test.mjs`
Expected: `buildSnapshot is not a function`（或未导出）

- [ ] **Step 3: 实现**

`index.html` 核心段追加：`HISTS` 常量（从 `server.mjs:27-35` 原样拷贝 6 个名字）、`buildSnapshot`（从 `server.mjs:110-149` 原样拷贝）、`computeRates(history)` —— 从 `server.mjs:170-184` 的 `Target.prototype.computeRates` 改造成纯函数（入参 history 数组，取末两项；`a < b` → null 规则不变）。更新尾部 exports。

- [ ] **Step 4: 运行确认通过**

Run: `node tests/snapshot.test.mjs`
Expected: 3 行 `ok`

- [ ] **Step 5: 回归 + Commit**

```bash
node tests/parser.test.mjs   # 仍全绿
git add index.html tests/snapshot.test.mjs
git commit -m "feat: snapshot build + delta rates (ported, counter-reset safe)"
```

---

### Task 3: 实例模型 + 持久化 + 失败分类

**Files:**
- Modify: `index.html`（核心段追加）
- Create: `tests/instance.test.mjs`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `metricsUrlOf(baseURL, metricsPath) -> string`（`new URL(baseURL).origin + (metricsPath || '/metrics')`）
  - `makeTarget(input) -> { id, name, baseURL, metricsPath, apiKey, enabled }`（默认 `metricsPath:''`、`apiKey:''`、`enabled:true`、`id: input.id || name + '-' + Date.now().toString(36)`；name 为空或 baseURL 非 http(s) 时 throw）
  - `loadTargets(storage) -> { targets: valid[], storageOk: boolean }`（`storageOk` 反映**存储机制本身的健康度**：storage 为 null 或 getItem 抛异常 → `{ targets: [], storageOk: false }`；值非法（JSON 解析失败 / 非数组）→ `{ targets: [], storageOk: true }`（存储可用、只是值坏了）；合法 JSON 数组 → 逐条过 `makeTarget` 校验，坏条目丢弃）
  - `saveTargets(storage, targets) -> boolean`（storage 为 null 或 setItem 抛异常 → false，**不 throw**）
  - `classifyFailure(input) -> { code, msg }`；`input = { status }` 或 `{ error }`：
    - status 200 → `{ code:'ok', msg:'' }`
    - 404 → `{ code:'http', msg:'HTTP 404：端点不存在 — 请在 metricsPath 指定实际路径（如 /vllm/metrics）' }`
    - 401|403 → `{ code:'auth', msg:'HTTP 401/403：鉴权失败 — 请检查 apiKey' }`
    - 其他 status → `{ code:'http', msg:'HTTP ' + status }`
    - `error.name` ∈ {TimeoutError, AbortError} → `{ code:'timeout', msg:'超时（8s）' }`
    - 其他 error → `{ code:'blocked', msg:'网络不可达或 CORS 拦截' }`

- [ ] **Step 1: 写失败测试 `tests/instance.test.mjs`**

```js
import assert from 'node:assert/strict';
import { loadCore, test } from './helpers.mjs';

const { metricsUrlOf, makeTarget, loadTargets, saveTargets, classifyFailure } = loadCore();

test('metricsUrlOf: 自动 /metrics 与显式前缀路径', () => {
  assert.equal(metricsUrlOf('https://h.example.com/v1'), 'https://h.example.com/metrics');
  assert.equal(metricsUrlOf('https://h.example.com:62818/vllm/v1', '/vllm/metrics'), 'https://h.example.com:62818/vllm/metrics');
});
test('makeTarget: 默认值与校验', () => {
  const t = makeTarget({ name: 'a', baseURL: 'https://your-vllm.example.com/v1' });
  assert.equal(t.metricsPath, '');
  assert.equal(t.apiKey, '');
  assert.equal(t.enabled, true);
  assert.ok(typeof t.id === 'string' && t.id.length > 1);
  assert.throws(() => makeTarget({ name: '', baseURL: 'https://x.example.com/v1' }));
  assert.throws(() => makeTarget({ name: 'a', baseURL: 'ftp://x.example.com' }));
});
test('loadTargets: 空 / 坏 JSON / 抛异常的 storage（file:// 禁 localStorage，Review Focus #1）', () => {
  const ok = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); } };
  ok.setItem('vllmmon.targets', 'garbage{');
  assert.deepEqual(loadTargets(ok), { targets: [], storageOk: true });
  const throwing = { getItem() { throw new Error('SecurityError: localStorage disabled'); }, setItem() { throw new Error('denied'); } };
  const r = loadTargets(throwing);
  assert.deepEqual(r.targets, []);
  assert.equal(r.storageOk, false);
  assert.deepEqual(loadTargets(null), { targets: [], storageOk: false });
});
test('saveTargets: 正常 true / 抛异常时 false 不抛出', () => {
  const ok = { setItem() {} };
  assert.equal(saveTargets(ok, []), true);
  assert.equal(saveTargets({ setItem() { throw new Error('quota'); } }, []), false);
  assert.equal(saveTargets(null, []), false);
});
test('classifyFailure: 404 提示 metricsPath（Review Focus #2）/ 401 / 超时 / 网络', () => {
  assert.equal(classifyFailure({ status: 200 }).code, 'ok');
  const f404 = classifyFailure({ status: 404 });
  assert.equal(f404.code, 'http');
  assert.match(f404.msg, /metricsPath/);
  assert.equal(classifyFailure({ status: 401 }).code, 'auth');
  assert.equal(classifyFailure({ status: 502 }).msg, 'HTTP 502');
  assert.equal(classifyFailure({ error: { name: 'TimeoutError' } }).code, 'timeout');
  assert.equal(classifyFailure({ error: { name: 'AbortError' } }).code, 'timeout');
  assert.equal(classifyFailure({ error: new Error('Failed to fetch') }).code, 'blocked');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/instance.test.mjs`
Expected: 未导出报错

- [ ] **Step 3: 实现** — 按上面 Interfaces 逐个实现（`makeTarget` 校验：`name.trim()` 非空；`new URL(baseURL)` 不抛且 protocol 为 http:/https:）。更新 exports。

- [ ] **Step 4: 运行确认通过**

Run: `node tests/instance.test.mjs && node tests/parser.test.mjs && node tests/snapshot.test.mjs`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add index.html tests/instance.test.mjs
git commit -m "feat: instance model, storage-safe persistence, failure classification"
```

---

### Task 4: 抓取循环（链式 / 退避 / 隐藏暂停 / 无爆发）

**Files:**
- Modify: `index.html`（核心段追加）
- Create: `tests/poller.test.mjs`

**Interfaces:**
- Consumes: `metricsUrlOf`（Task 3）
- Produces:
  - `nextDelayMs(elapsedMs, intervalMs) -> number`（`Math.max(0, intervalMs - elapsedMs)`）
  - `intervalFor(failed, intervalMs, backoffMs = 5000) -> number`（`failed ? Math.max(intervalMs, backoffMs) : intervalMs`）
  - `createPoller({ targets, fetchFn(url, target), intervalMs = 2000, backoffMs = 5000, now = Date.now, schedule(fn, ms, target), cancel(handle, target), onSample(id, snap), onFail(id, err) }) -> { start, stop, running }`
    - 注入签名：`schedule/cancel` 形如 setTimeout 且**尾随第 3 参 `target`**；默认实现 `(fn, ms) => setTimeout(fn, ms)` / `(h) => clearTimeout(h)` 忽略它，测试用它给 timer 归因到实例
    - `start()`：每个 enabled 的 target 立即发 1 次 fetch（在途 1 个）；完成后按 `nextDelayMs(本次耗时, intervalFor(该 target 处于失败退避))` 调度下一拍
    - fetch 成功 → `onSample`，清除该 target 失败标记；失败 → `onFail`，进入退避
    - `stop()`：cancel 所有待定 timer，置 `running=false`；再次 `start()` 后每 target 恰好 1 个在途请求（不补发、不爆发）

- [ ] **Step 1: 写失败测试 `tests/poller.test.mjs`**

```js
import assert from 'node:assert/strict';
import { loadCore, test, flush } from './helpers.mjs';

const { nextDelayMs, intervalFor, createPoller } = loadCore();
const T = (id) => ({ id, name: id, baseURL: 'https://your-vllm.example.com/v1', metricsPath: '', apiKey: '', enabled: true });

test('nextDelayMs: 链式不重叠', () => {
  assert.equal(nextDelayMs(1200, 2000), 800);
  assert.equal(nextDelayMs(3000, 2000), 0);
  assert.equal(nextDelayMs(500, 1000), 500);
});
test('intervalFor: 失败退避 5s，不低于常规间隔', () => {
  assert.equal(intervalFor(false, 2000), 2000);
  assert.equal(intervalFor(true, 2000), 5000);
  assert.equal(intervalFor(true, 5000), 5000);
});
test('start(): 每 target 恰好 1 个在途请求（无爆发，Review Focus #5）', async () => {
  let nextId = 0;
  const timers = [];
  const p = createPoller({
    targets: [T('a'), T('b')],
    fetchFn: async () => ({ ok: true, text: async () => '' }),
    schedule: (fn, ms) => { const id = ++nextId; timers.push({ id, cancelled: false }); return id; },
    cancel: (h) => { const t = timers.find((x) => x.id === h); if (t) t.cancelled = true; },
  });
  const alive = () => timers.filter((t) => !t.cancelled).length;
  p.start();
  await flush();
  assert.equal(alive(), 2);              // 每 target 各 1 个待定 timer
  p.stop();
  assert.equal(alive(), 0);              // stop 全部 cancel
  p.start();
  await flush();
  assert.equal(alive(), 2);              // 重启仍 1:1，不累积
  p.stop();
});
test('失败隔离：A 挂掉不影响 B 的调度（Review Focus #4）', async () => {
  const aTimers = [], bTimers = [];
  const samples = [], fails = [];
  const p = createPoller({
    targets: [T('a'), T('b')],
    fetchFn: async (url, t) => (t.id === 'a' ? Promise.reject(new Error('ECONNREFUSED')) : { ok: true, text: async () => '' }),
    intervalMs: 2000,
    now: () => 0, // 冻结时钟：本次耗时 = 0 → 延迟断言确定
    schedule: (fn, ms, t) => (t.id === 'a' ? aTimers : bTimers).push({ fn, ms }),
    onSample: (id) => samples.push(id),
    onFail: (id) => fails.push(id),
  });
  p.start();
  await flush();
  assert.deepEqual(fails, ['a']);
  assert.deepEqual(samples, ['b']);
  assert.equal(aTimers[0].ms, 5000);   // A 退避
  assert.equal(bTimers[0].ms, 2000);   // B 正常间隔（冻结时钟，耗时=0）
  p.stop();
});
```

> 注：契约为 `fetchFn(url, target)`；`schedule/cancel` 形如 setTimeout 且尾随第 3 参 `target`（默认实现忽略之，测试用它给 timer 归因到实例）。隔离测试用 `now: () => 0` 冻结时钟，使延迟断言确定。

- [ ] **Step 2: 运行确认失败**

Run: `node tests/poller.test.mjs`
Expected: 未导出报错

- [ ] **Step 3: 实现** — 按 Interfaces 实现 `createPoller`：每 target 一个 `run()` 闭包（串行链）；`fetchFn(url, target)` 为约定签名；timer handle 存每 target 独立槽位供 `stop()` cancel。更新 exports。

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `node tests/poller.test.mjs && node tests/parser.test.mjs && node tests/snapshot.test.mjs && node tests/instance.test.mjs`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add index.html tests/poller.test.mjs
git commit -m "feat: chained poller with backoff, isolation, resume-without-burst"
```

---

### Task 5: 页面骨架 + 双模式渲染 + 轮询接线

**Files:**
- Modify: `index.html`（HTML 结构 + `<style>` + UI 段：boot、实例 pills、12 卡、4 图、模式/间隔切换、visibilitychange、canvas 绘图、环形缓冲）
- Create: `tests/mock-server.mjs`（零依赖 mock vLLM metrics 服务，仅 127.0.0.1）

**Interfaces:**
- Consumes: Task 1-4 全部核心函数 + `vllmmon.*` localStorage keys
- Produces（供 Task 6）: 模态挂载点 `<div id="modal-root">`、`openAddModal()`、`applyTargets(targets)`（重建 pills + 重启 poller）、`renderSnapshot(targetId, snap)`（新数据点进环形缓冲并批量刷 DOM）

- [ ] **Step 1: 创建 mock server `tests/mock-server.mjs`**

零依赖 `node:http`，监听 `127.0.0.1`，端口 `MOCK_PORT || 8931`，所有响应带 `Access-Control-Allow-Origin: *`（OPTIONS 预检 204 + `allow-headers: authorization`）：

- `GET /metrics` → 200，fixture：`vllm:num_requests_running`（engine 0=3、1=1，model_name="mock-model"）、`waiting=2`、`kv_cache_usage_perc=0.42`、`num_preemptions_total=5`、`prompt_tokens_total=1000`、`generation_tokens_total=123*请求计数`（每次递增，速率非 0）、`request_success_total{finished_reason="stop"}=41+请求计数`、一条 `time_to_first_token_seconds` 直方图（le=0.5/1/2/+Inf，count/sum）、`process_resident_memory_bytes=2147483648`
- `GET /vllm/metrics` → 同上（metricsPath 场景）
- `GET /nope/metrics` → 404（诊断场景）
- `GET /authz/metrics` → 无 `Authorization: Bearer mock-key` 时 401，否则 200 同 fixture

Run 验证：`node tests/mock-server.mjs &` 后 `curl -s localhost:8931/metrics | head -3` 看到 `vllm:` 行，`curl -sI localhost:8931/nope/metrics` → 404

- [ ] **Step 2: 实现页面骨架与渲染（`index.html`）**

- 结构：`<header>`（标题 + 间隔切换 1s/2s/5s + 模式切换 精简/完整）、`#pills`（实例 pills 横滑 + 状态点）、`#banner`（断连提示，默认 hidden）、`.cards`（12 卡：运行/排队/KV/生成速度/预填充速度/TTFT p50/E2E p99/成功请求/抢占/内存/模型 + 条件显示的投机解码卡，id 沿用现有 `v-*` 命名）、`.charts`（4 个 canvas：c1 请求数量 running/waiting、c2 KV、c3 Token 吞吐 generation/prompt、c4 延迟 TTFT p50/E2E p99，图例 lg1-4）、`#modal-root`
- CSS：`body.mode-lite`（窄屏：单列、卡片行横滑、只显示 6 核心卡 + c3/c4 两图、触控目标 ≥44px）与 `body.mode-full`（12 卡网格 + 4 图）；KV ≥70% 橙 / ≥90% 红（沿用 `kv-warm`/`kv-hot`）
- JS：每实例环形缓冲 `{ running, waiting, kv, gen, prompt, ttftP50, e2eP99 }` 各 `RING_MAX=2400`（`push` + `shift`）；canvas 按 `Math.min(devicePixelRatio, 2)` 缩放，仅新数据点到达重绘；DOM 更新走缓存元素 `textContent` 每拍批量写（沿用 `public/app.js` 的 setNum/draw/legend 逻辑移植）
- `boot()`：读 `vllmmon.*`（`loadTargets`/`saveTargets`，`storageOk=false` 时顶部 toast "本地设置无法保存，刷新后丢失"）；首开 `vllmmon.mode` 缺省时按 `innerWidth < MODE_MIN_WIDTH(640)` 自动选 lite/full；`vllmmon.interval` 缺省 `2000`；空列表 → 欢迎态（大按钮 → `openAddModal()`）；用 `createPoller` 接线（`fetchFn` = 真实 fetch + `AbortSignal.timeout(FETCH_TIMEOUT_MS)` + 非空固定 UA + 有 key 时 Bearer 头）；`visibilitychange`：hidden → `poller.stop()`，visible → `poller.start()`
- 断连：poller `onFail` → 该 pill 状态点变红 + `#banner` 显示 "实例 X 已断连，每 5s 重试"

- [ ] **Step 3: 语法 + 手工验证（file:// 直开，mock 后端）**

```bash
node -e "const h=require('node:fs').readFileSync('index.html','utf8');new (require('node:vm').Script)(h.match(/<script>([\s\S]*)<\/script>/)[1]);console.log('syntax OK')"
node tests/mock-server.mjs &   # 或后台 shell
# 浏览器（Chrome/Safari）以 file:// 直接打开 index.html：
```

Expected 逐项过：
1. 空态：欢迎界面 + "添加"按钮（无内置实例）
2. 添加实例 name=`mock`、baseURL=`http://127.0.0.1:8931`（metricsPath 留空）→ 5s 内卡片出数：运行 4、排队 2、KV 42.0%、模型 mock-model；第 2 拍后 4 图出现线
3. 窗口宽度 <640 首开 → `document.body.className` 含 `mode-lite`；点"完整" → `localStorage.vllmmon.mode === 'full'`，刷新后保持
4. 切到其他标签页 3s → mock server 日志停止该端点请求；切回 → 恢复（且无成串爆发请求）
5. DevTools Network 面板：除 `127.0.0.1:8931` 外 **0** 请求

- [ ] **Step 4: Commit**

```bash
git add index.html tests/mock-server.mjs
git commit -m "feat: page shell, dual-mode render, poller wiring, mock metrics server"
```

---

### Task 6: 实例管理 UI + 测试连接 + 断连 banner

**Files:**
- Modify: `index.html`（模态与诊断 UI 段）

**Interfaces:**
- Consumes: Task 5 的 `openAddModal()` / `applyTargets()` / `#modal-root`；Task 3 的 `makeTarget` / `classifyFailure` / `metricsUrlOf`
- Produces: 完整的增删改 UI（本任务是 UI 收尾，不新增核心函数）

- [ ] **Step 1: 实现**

- 添加/编辑模态：字段 name / baseURL / metricsPath（占位 `/vllm/metrics`，提示"留空 = 自动 origin+/metrics"）/ apiKey（提示"仅存本机"）/ enabled 开关；保存前自动跑一次**测试连接**：单次 `fetch(metricsUrlOf(baseURL, metricsPath), { headers })`（带 key 则 Bearer），结果用 `classifyFailure` 渲染：
  - `ok` → 绿色 "连接成功：模型 X，含 vllm:* 指标 N 条"（解析响应文本里 `vllm:` 行计数）
  - 404 → 黄色 "HTTP 404：端点不存在 — 请在 metricsPath 指定实际路径（如 /vllm/metrics）"
  - 401/403 → "请检查 apiKey"；timeout → "超时（8s）"；blocked → "网络不可达或 CORS 拦截"
- 每实例 pill：点选切换激活实例；`×` 删除（localStorage 同步）；enabled 开关独立于删除
- banner：任一实例失败时汇总显示（多个实例失败时逐行列出），全部恢复后自动隐藏

- [ ] **Step 2: 手工验证（mock server 在跑）**

1. 添加 `mock`（`http://127.0.0.1:8931`）→ 测试连接绿 "连接成功：模型 mock-model，含 vllm:* 指标 N 条"（Review Focus #2 的正向对照）
2. 添加 `bad404`（baseURL `http://127.0.0.1:8931/nope/v1`，metricsPath 留空）→ 诊断文案含 "metricsPath"（**Review Focus #2**）；再填 metricsPath=`/vllm/metrics` 并把 baseURL 改 `http://127.0.0.1:8931/vllm/v1` → 成功
3. 添加 `auth`（baseURL `http://127.0.0.1:8931/authz/v1`，metricsPath=`/authz/metrics`）：不填 key → 401 诊断"请检查 apiKey"；填 `mock-key` → 成功；DevTools 确认该 key 只出现在发往 8931 端点的请求里（注：mock 的 `/metrics` 本身 200，空 metricsPath 不会 404，所以本步直接填 `/authz/metrics`）
4. 关掉某实例的 enabled → mock 日志中该端点请求停止，状态点灰；重新打开 → 恢复
5. `kill` mock server → 各 pill 变红 + banner 出现；重启 mock → 一拍后自动恢复、banner 消失

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: instance modal with connection test, banner, per-instance enable"
```

---

### Task 7: README + 清理 + 最终验收

**Files:**
- Create: `README.md`
- Delete: `monitor.html`（`git rm`，spec §10：遗留单文件，被 index.html 取代）

**Interfaces:**
- Consumes: 全部前序任务产物

- [ ] **Step 1: 写 `README.md`**

内容（**全部用占位 URL，不出现任何真实端点/key**）：
1. **单文件版（推荐）**：双击/微信打开 `index.html` → 添加实例（name + baseURL [+ metricsPath] [+ apiKey]）；手机端：把 `index.html` 经微信发给自己 → 点开即用；说明 metrics 端点通常无需 key（vLLM `--api-key` 只保护 OpenAI API 路由）、数据只存本机 localStorage、页面隐藏自动停轮询省流量
2. **server 版（旧）**：`node server.mjs`，`PORT`/`scrapeMs` 说明，`config.json` 从 `config.json.example` 复制并填自己的端点（真实 config.json 不进 git）
3. **测试**：`node tests/mock-server.mjs`（mock 端点表：/metrics、/vllm/metrics、/nope/metrics→404、/authz/metrics→需 Bearer `mock-key`）；`node tests/parser.test.mjs` 等逐个跑
4. **发布**：`git remote add origin <你的 GitHub 仓库>` → push main + feat/static-single-file

- [ ] **Step 2: 删除遗留单文件**

```bash
git rm monitor.html
```

- [ ] **Step 3: 最终验收（spec §12 全项）**

```bash
# 1) 单测全绿
for f in tests/*.test.mjs; do node "$f" || exit 1; done
# 2) 文件体积 < 80KB
[ "$(wc -c < index.html)" -lt 81920 ] && echo "size OK: $(wc -c < index.html) bytes"
# 3) 零外部请求
! grep -nE 'src=|href="http|@import|url\(http' index.html && echo "no external refs"
# 4) 零真实端点/密钥（用会话上下文里所有者真实域名与 key 的值做 grep；该值本身不得写入本仓库任何文件）
git grep -nE '<真实域名模式>' -- . && echo "LEAK" || echo "no real endpoints"
# 5) 旧版可用
git stash -q; git checkout main -q; node server.mjs & sleep 3; kill %1 2>/dev/null; git checkout feat/static-single-file -q; git stash pop -q
git status --short   # 应为空
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: usage README; chore: remove legacy monitor.html"
```

---

## 执行顺序与依赖

Task 1 → 2 → 3 → 4 → 5 → 6 → 7 严格顺序（后续任务消费前序接口；全部落在同一个 `index.html`，不可并行）。Task 5/6 的手工验证需要 mock server 在跑。

## 计划自审结果（writing-plans self-review）

- **Spec 覆盖**：§3 约束 → Global Constraints；§4 架构 → T1-T5；§5 → T3+T6；§6 → T1+T2；§7 → T4+T5 接线；§8 → T5；§9（DPR/批量 DOM/环形缓冲）→ T5 步骤 2 明列；§10 → T7；§12 验收 → T7 步骤 3。无缺口。
- **步骤扫描**：每个 step 均给出精确断言/命令/签名；无 "handle edge cases" 类空话。
- **类型一致性**：`metricsUrlOf(baseURL, metricsPath)`、`createPoller({ targets, fetchFn(url, target), ... })`、`loadTargets -> { targets, storageOk }` 等跨任务签名已统一。
- **Review Focus**：5 条输入类各有钉住的测试（T2/T3/T4）+ 手工验证项（T5/T6）。
- **篇幅**：计划 ≈ spec 的 2.5 倍，增量主要是可执行步骤与测试代码，无转录冗余。
