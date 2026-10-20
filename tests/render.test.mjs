// 渲染映射纯函数：modelState（MODEL 卡状态）+ factsFromSnap（Requests 面板 facts 网格数据）
import assert from 'node:assert/strict';
import { loadCore, test, deepEqual } from './helpers.mjs';

const { modelState, factsFromSnap } = loadCore();

test('modelState: running > 0 → Running', () => {
  assert.ok(deepEqual(modelState({ up: true, gauges: { running: 2, waiting: 0 } }), { cls: 'run', label: 'Running' }));
});
test('modelState: running 0 + waiting > 0 → Queued', () => {
  assert.ok(deepEqual(modelState({ up: true, gauges: { running: 0, waiting: 3 } }), { cls: 'wait', label: 'Queued' }));
});
test('modelState: 均为 0 → Idle', () => {
  assert.ok(deepEqual(modelState({ up: true, gauges: { running: 0, waiting: 0 } }), { cls: 'idle', label: 'Idle' }));
});
test('modelState: 断连 → Disconnected（优先于 running）', () => {
  assert.ok(deepEqual(modelState({ up: false, gauges: { running: 2, waiting: 0 } }), { cls: 'down', label: 'Disconnected' }));
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

test('factsFromSnap: 12 项 facts（label + 格式化值）', () => {
  const facts = factsFromSnap(SNAP);
  assert.equal(facts.length, 12);
  const by = Object.fromEntries(facts.map((f) => [f.label, f.value]));
  assert.equal(by['队列等待 p50'], '50 ms');
  assert.equal(by['队列等待 p99'], '900 ms');
  assert.equal(by['首 token p50'], '600 ms');
  assert.equal(by['首 token p99'], '1.90 s');
  assert.equal(by['端到端 p50'], '1.20 s');
  assert.equal(by['端到端 p99'], '8.80 s');
  assert.equal(by['解码速度'], '120 tok/s');
  assert.equal(by['Prompt tokens'], '1000');
  assert.equal(by['Generation tokens'], '2000');
  assert.equal(by['缓存命中'], '30.0%');
  assert.equal(by['抢占次数'], '5.00'); // fmtN 口径（与现有 preemptions 卡一致）
  assert.equal(by['投机解码接受率'], '80.0%');
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
  assert.equal(by['队列等待 p50'], '–');
  assert.equal(by['首 token p50'], '–'); // 整个 hist key 缺失
  assert.equal(by['解码速度'], '–');
  assert.equal(by['缓存命中'], '–');
  assert.equal(by['投机解码接受率'], '–');
});
