import assert from 'node:assert/strict';
import { loadCore, test, deepEqual } from './helpers.mjs';

const { decimIdx } = loadCore();

test('decimIdx: n ≤ maxPts 恒等（n=3 ≤ 10 → 每点都画）', () => {
  assert.ok(deepEqual(decimIdx([1, 2, 3], 3, 10), [0, 1, 2]));
});

test('decimIdx: min-max 桶降采样（buckets=2、bsize=3：桶0 min@1/max@0 → [0,1]；桶1 min@4/max@3 → [3,4]；尾补 n-1=5）', () => {
  assert.ok(deepEqual(decimIdx([5, 1, 3, 9, 2, 4], 6, 4), [0, 1, 3, 4, 5]));
});

test('decimIdx: 全 null 桶 → -1 断线标记（桶1 有 min=max=2@4；末端全 null 补 -1）', () => {
  assert.ok(deepEqual(decimIdx([1, null, null, null, 2, null, null, null], 8, 4), [0, 4, -1]));
});

test('decimIdx: 单点恒等（n=1 ≤ 2 → [0]）', () => {
  assert.ok(deepEqual(decimIdx([7], 1, 2), [0]));
});
