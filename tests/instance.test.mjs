import assert from 'node:assert/strict';
import { loadCore, test, deepEqual } from './helpers.mjs';

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
  assert.ok(deepEqual(loadTargets(ok), { targets: [], storageOk: true }));
  const throwing = { getItem() { throw new Error('SecurityError: localStorage disabled'); }, setItem() { throw new Error('denied'); } };
  const r = loadTargets(throwing);
  assert.ok(deepEqual(r.targets, []));
  assert.equal(r.storageOk, false);
  assert.ok(deepEqual(loadTargets(null), { targets: [], storageOk: false }));
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
  const fBlocked = classifyFailure({ error: new Error('Failed to fetch') });
  assert.equal(fBlocked.code, 'blocked');
  assert.match(fBlocked.msg, /CORS/);
  assert.match(fBlocked.msg, /--allowed-origins/);
});
