import assert from 'node:assert/strict';
import { loadCore, test, deepEqual } from './helpers.mjs';

const { metricsUrlOf, makeTarget, loadTargets, saveTargets, classifyFailure, T } = loadCore();

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
  assert.throws(() => makeTarget({ name: 'a', baseURL: 'ftp://x.example.com' }));
  assert.throws(() => makeTarget({ name: 'a', baseURL: 'not a url' }));
});
test('makeTarget: 名称留空时取域名（不得因此挡住添加实例）', () => {
  const t = makeTarget({ name: '', baseURL: 'http://192.168.1.9:50218/v1' });
  assert.equal(t.name, '192.168.1.9');
  assert.ok(t.id.startsWith('192.168.1.9-'));
  // 从旧配置载入的条目也允许无名
  const storage = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = String(v); } };
  storage.setItem('vllmmon.targets', JSON.stringify([{ baseURL: 'http://192.168.1.9:50218/v1' }]));
  assert.equal(loadTargets(storage).targets[0].name, '192.168.1.9');
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
test('makeTarget: 传入 id → 保留（编辑流程依赖：id 不变则历史/activeId 连续）', () => {
  const t = makeTarget({ id: 'keep-1', name: 'renamed', baseURL: 'https://a.example.com/v1', metricsPath: '/m', apiKey: 'k', enabled: false });
  assert.equal(t.id, 'keep-1');
  assert.equal(t.name, 'renamed');
  assert.equal(t.metricsPath, '/m');
  assert.equal(t.apiKey, 'k');
  assert.equal(t.enabled, false);
});

test('i18n: 编辑/删除相关 key 中英齐全（实例管理 UI）', () => {
  T.__setLang('zh');
  assert.equal(T('editInst'), '编辑实例');
  assert.equal(T('modalEditTitle'), '编辑监控实例');
  assert.equal(T('save'), '保存');
  assert.equal(T('chkEnableEdit'), '编辑后启用监控');
  assert.equal(T('deleteInst'), '删除实例');
  T.__setLang('en');
  assert.equal(T('editInst'), 'Edit instance');
  assert.equal(T('modalEditTitle'), 'Edit instance');
  assert.equal(T('save'), 'Save');
  assert.equal(T('chkEnableEdit'), 'Enable monitoring after saving');
  assert.equal(T('deleteInst'), 'Remove instance');
  T.__setLang('zh'); // 还原
});

test('classifyFailure: HTTPS 页面抓 HTTP 端点 → mixed（与 CORS 区分）', () => {
  const f = classifyFailure({ mixed: true });
  assert.equal(f.code, 'mixed');
  assert.match(f.msg, /HTTPS|混合|mixed/);
  assert.equal(classifyFailure({ error: { mixed: true } }).code, 'mixed');
  assert.equal(classifyFailure({ status: 200 }).code, 'ok');
});
