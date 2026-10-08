import assert from 'node:assert/strict';
import { loadCore, test, deepEqual } from './helpers.mjs';

const { evict, xFrac, pickTickStep, VALUE_KEYS } = loadCore();

test('evict: ts < cut 全部 shift（含值 null 的点），ts === cut 保留，值数组与 ts 同步', () => {
  // cut = nowMs - windowMs = 1900000 - 1800000 = 100000
  const st = {
    ts: [50000, 99999, 100000, 150000],
    running: [1, null, 3, 4],
    waiting: [null, 2, null, 1],
    kv: [10, 10, 20, 20],
    gen: [0, 1, 2, 3],
    prompt: [null, null, null, null],
    ttftP50: [null, 0.5, 0.6, 0.7],
    e2eP99: [1, null, null, 1.2],
  };
  assert.equal(VALUE_KEYS.length, 7);
  assert.ok(deepEqual(st.ts.map((t) => t), [50000, 99999, 100000, 150000]));
  evict(st, 1900000, 1800000);
  assert.ok(deepEqual(st.ts, [100000, 150000]));            // 恰好等于 cut 的点保留
  for (const k of VALUE_KEYS) assert.equal(st[k].length, 2, k + ' 与 ts 同步变短');
  assert.ok(deepEqual(st.running, [3, 4]));                   // null 值点同样被 shift
  assert.ok(deepEqual(st.waiting, [null, 1]));
  assert.ok(deepEqual(st.prompt, [null, null]));
});

test('pickTickStep: 从 [1,2,5,10,15,30,60,120,240] 取第一个使 windowMin/step<=6 的值', () => {
  assert.equal(pickTickStep(600000), 2);   // 10 分钟 → 2
  assert.equal(pickTickStep(1800000), 5);  // 30 分钟 → 5
  assert.equal(pickTickStep(3600000), 10); // 60 分钟 → 10
  assert.equal(pickTickStep(5400000), 15); // 90 分钟 → 15
});

test('xFrac: 夹在 0..1，d<=0 返回 1（空 store / t0===t1 不产生 NaN）', () => {
  assert.equal(xFrac(5, 0, 10), 0.5);
  assert.equal(xFrac(-5, 0, 10), 0);
  assert.equal(xFrac(15, 0, 10), 1);
  assert.equal(xFrac(5, 10, 10), 1);
});
