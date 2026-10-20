// httpStats：聚合 http_requests_total{handler,method,status} → 每路由 2xx/4xx/5xx 计数
// 只读扩展（与 buildSnapshot 同管道、同输入），不改动现有解析函数
import assert from 'node:assert/strict';
import { loadCore, test, deepEqual } from './helpers.mjs';

const { parseProm, httpStats } = loadCore();

const FIX = `
http_requests_total{handler="/v1/chat/completions",method="POST",status="2xx"} 51
http_requests_total{handler="/v1/chat/completions",method="POST",status="4xx"} 2
http_requests_total{handler="/v1/chat/completions",method="POST",status="5xx"} 1
http_requests_total{handler="/metrics",method="GET",status="2xx"} 300
http_requests_total{handler="/v1/models",method="GET",status="2xx"} 7
`;

test('httpStats: 每路由聚合 2xx/4xx/5xx + total，按 total 降序', () => {
  const rows = httpStats(parseProm(FIX));
  assert.equal(rows.length, 3);
  assert.ok(deepEqual(rows[0], { handler: '/metrics', method: 'GET', '2xx': 300, '4xx': 0, '5xx': 0, total: 300 }));
  assert.ok(deepEqual(rows[1], { handler: '/v1/chat/completions', method: 'POST', '2xx': 51, '4xx': 2, '5xx': 1, total: 54 }));
  assert.ok(deepEqual(rows[2], { handler: '/v1/models', method: 'GET', '2xx': 7, '4xx': 0, '5xx': 0, total: 7 }));
});

test('httpStats: 未知 status（3xx）计入 total 但不进任何桶', () => {
  const rows = httpStats(parseProm('http_requests_total{handler="/h",method="GET",status="3xx"} 5'));
  assert.ok(deepEqual(rows, [{ handler: '/h', method: 'GET', '2xx': 0, '4xx': 0, '5xx': 0, total: 5 }]));
});

test('httpStats: 无 handler label 的条目跳过', () => {
  const rows = httpStats(parseProm('http_requests_total{method="GET",status="2xx"} 3'));
  assert.ok(deepEqual(rows, []));
});

test('httpStats: 无 http_requests_total 指标 → []（旧版 vLLM 兼容）', () => {
  assert.ok(deepEqual(httpStats(parseProm('vllm:num_requests_running 1')), []));
});

test('httpStats: 同 handler 不同 method → 分行；同 total 按 handler、method 升序', () => {
  const rows = httpStats(parseProm(`
http_requests_total{handler="/h",method="POST",status="2xx"} 5
http_requests_total{handler="/h",method="GET",status="2xx"} 5
`));
  assert.ok(deepEqual(rows.map((r) => r.method), ['GET', 'POST']));
});

test('httpStats: 负计数（畸形抓取）不渲染，total 不为负', () => {
  const rows = httpStats(parseProm(`
http_requests_total{handler="/h",method="GET",status="2xx"} -5
http_requests_total{handler="/ok",method="GET",status="2xx"} 3
`));
  assert.ok(deepEqual(rows, [{ handler: '/ok', method: 'GET', '2xx': 3, '4xx': 0, '5xx': 0, total: 3 }]));
});

// ---------- vllmCountOf：成功提示的 vllm:* 指标计数（只数样例行，排除 # HELP / # TYPE 注释）----------

const { vllmCountOf } = loadCore();

test('vllmCountOf: 计数 vllm:* 样例行，注释行不计', () => {
  assert.equal(vllmCountOf(`
# HELP vllm:num_requests_running Number of requests currently running.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0"} 2
vllm:num_requests_waiting{engine="0"} 1
`), 2);
});

test('vllmCountOf: 无 vllm:* 行 → 0', () => {
  assert.equal(vllmCountOf('# HELP vllm:num_requests_running gauge\nup 1\n'), 0);
});

test('vllmCountOf: 空文本 → 0', () => {
  assert.equal(vllmCountOf(''), 0);
});
