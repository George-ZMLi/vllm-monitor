// 渲染映射纯函数：modelState（MODEL 卡状态）+ factsFromSnap（Requests 面板 facts 网格数据）
import assert from 'node:assert/strict';
import { loadCore, test, deepEqual } from './helpers.mjs';

const { modelState, factsFromSnap, T } = loadCore();

// 语言固定为 zh（T() 依赖模块级 lang 状态）
T.__setLang && T.__setLang('zh');

test('modelState: running > 0 → stRunning', () => {
  assert.ok(deepEqual(modelState({ up: true, gauges: { running: 2, waiting: 0 } }), { cls: 'run', key: 'stRunning' }));
});
test('modelState: running 0 + waiting > 0 → stQueued', () => {
  assert.ok(deepEqual(modelState({ up: true, gauges: { running: 0, waiting: 3 } }), { cls: 'wait', key: 'stQueued' }));
});
test('modelState: 均为 0 → stIdle', () => {
  assert.ok(deepEqual(modelState({ up: true, gauges: { running: 0, waiting: 0 } }), { cls: 'idle', key: 'stIdle' }));
});
test('modelState: 断连 → stDisconnected（优先于 running）', () => {
  assert.ok(deepEqual(modelState({ up: false, gauges: { running: 2, waiting: 0 } }), { cls: 'down', key: 'stDisconnected' }));
});

const SNAP = {
  up: true,
  ts: Date.now(),
  gauges: {
    running: 4, waiting: 2, kvPct: 42, preemptions: 5,
    promptTokens: 1000, generationTokens: 2000,
    cachedPromptTokens: 300, residentMb: 2048,
  },
  rates: { promptTokensPerS: 15, generationTokensPerS: 120, requestsPerS: 1, preemptionsPerS: 0 },
  successTotal: 45,
  successByReason: { stop: 41, length: 4 },
  models: ['m1'], engines: ['0'],
  specDecode: { drafts: 100, accepted: 80, acceptRate: 0.8 },
  hist: {
    request_queue_time_seconds: { count: 50, avg: 0.1, p50: 0.05, p99: 0.9 },
    time_to_first_token_seconds: { count: 50, avg: 0.61, p50: 0.6, p99: 1.9 },
    e2e_request_latency_seconds: { count: 50, avg: 2, p50: 1.2, p99: 8.8 },
  },
  cacheHit: 30,
  routes: [],
};

test('factsFromSnap: 12 项 facts（i18n key label + 格式化值）', () => {
  const facts = factsFromSnap(SNAP);
  assert.equal(facts.length, 12);
  const by = Object.fromEntries(facts.map((f) => [f.label, f.value]));
  assert.equal(by['fq.p50'], '50 ms');
  assert.equal(by['fq.p99'], '900 ms');
  assert.equal(by['ft.p50'], '600 ms');
  assert.equal(by['ft.p99'], '1.90 s');
  assert.equal(by['e2e.p50'], '1.20 s');
  assert.equal(by['e2e.p99'], '8.80 s');
  assert.equal(by['decode.speed'], '120 tok/s');
  assert.equal(by['pt'], '1000');
  assert.equal(by['gt'], '2000');
  assert.equal(by['cache.hit'], '30.0%');
  assert.equal(by['preem'], '5.00'); // fmtN 口径（与现有 preemptions 卡一致）
  assert.equal(by['spec.accept'], '80.0%');
});

test('factsFromSnap: 直方图缺失 / rates 缺失 / 无投机解码 / 无缓存命中 → –', () => {
  const snap = {
    ...SNAP,
    rates: null,
    specDecode: null,
    cacheHit: null,
    hist: { request_queue_time_seconds: { count: 0, avg: null, p50: null, p99: null } },
  };
  const by = Object.fromEntries(factsFromSnap(snap).map((f) => [f.label, f.value]));
  assert.equal(by['fq.p50'], '–');
  assert.equal(by['ft.p50'], '–'); // 整个 hist key 缺失
  assert.equal(by['decode.speed'], '–');
  assert.equal(by['cache.hit'], '–');
  assert.equal(by['spec.accept'], '–');
});

// ---------- T()：i18n 翻译（zh 缺省 / en 切换 / 占位符替换 / 缺失回落 key）----------

test('T(zh): 默认语言返回中文', () => {
  assert.equal(T('requests'), '请求');
  assert.equal(T('stRunning'), '运行中');
  assert.equal(T('latency'), '延迟');
});

test('T(en): 切换语言返回英文', () => {
  T.__setLang('en');
  assert.equal(T('requests'), 'Requests');
  assert.equal(T('stRunning'), 'Running');
  assert.equal(T('latency'), 'Latency');
  T.__setLang('zh'); // 还原，避免污染后续测试
});

test('T: 占位符按序替换（sSucc / foot）', () => {
  assert.equal(T('sSucc', [4, 3]), '4 running · 3 waiting');
  assert.equal(T('foot', ['prod', 2, 30]), '数据仅存于本浏览器 · 实例 prod · 每 2s · 窗口 30 分钟');
});

test('T: 缺失 key 回落为 key 本身', () => {
  assert.equal(T('no.such.key'), 'no.such.key');
});
