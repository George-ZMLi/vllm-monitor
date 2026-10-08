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
