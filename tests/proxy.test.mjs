// ninfer-proxy 测试：路由、鉴权透传、SSE 流式不缓冲、上游宕机 502
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { startProxy, parseUpstream } from '../ninfer-proxy.mjs';

function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

test('parseUpstream', () => {
  assert.deepEqual(parseUpstream('127.0.0.1:50219'), { host: '127.0.0.1', port: 50219 });
  assert.throws(() => parseUpstream('nope'));
});

test('路由：/metrics 走桥，其余走 nInfer；鉴权头原样透传', async () => {
  const ninfer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ where: 'ninfer', auth: req.headers.authorization || null, url: req.url }));
  });
  const bridge = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('BRIDGE ' + (req.headers.authorization || 'no-auth'));
  });
  const pN = await listen(ninfer), pB = await listen(bridge);
  const proxy = await startProxy({ frontPort: 0, ninferUpstream: '127.0.0.1:' + pN, bridgeUpstream: '127.0.0.1:' + pB });
  const pf = proxy.address().port;
  try {
    let r = await fetch('http://127.0.0.1:' + pf + '/metrics', { headers: { authorization: 'Bearer k1' } });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'BRIDGE Bearer k1');
    r = await fetch('http://127.0.0.1:' + pf + '/v1/models', { headers: { authorization: 'Bearer k1' } });
    let body = JSON.parse(await r.text());
    assert.equal(body.where, 'ninfer');
    assert.equal(body.auth, 'Bearer k1');
    assert.equal(body.url, '/v1/models');
  } finally { proxy.close(); ninfer.close(); bridge.close(); }
});

test('SSE 流式透传：块逐一到达且顺序正确（不缓冲整包）', async () => {
  const sse = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    for (let i = 1; i <= 5; i++) {
      setTimeout(() => { res.write('data: tok' + i + '\n\n'); }, i * 40);
    }
    setTimeout(() => res.end(), 260);
  });
  const pS = await listen(sse);
  const proxy = await startProxy({ frontPort: 0, ninferUpstream: '127.0.0.1:' + pS, bridgeUpstream: '127.0.0.1:1' });
  const pf = proxy.address().port;
  try {
    const t0 = Date.now();
    const arrivals = [];
    const res = await fetch('http://127.0.0.1:' + pf + '/v1/chat/completions');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) arrivals.push({ at: Date.now() - t0, chunk: dec.decode(value, { stream: true }) });
    }
    const joined = arrivals.map((a) => a.chunk).join('');
    assert.ok(joined.includes('data: tok1') && joined.includes('data: tok5'), joined);
    // 第一块应在 ~40ms 左右到达，而不是等 ~260ms 整包
    assert.ok(arrivals[0].at < 200, 'first chunk at ' + arrivals[0].at + 'ms (should stream, not buffer)');
    const order = ['tok1','tok2','tok3','tok4','tok5'].map((t) => joined.indexOf('data: ' + t));
    assert.deepEqual([...order].sort((a,b)=>a-b), order, 'order preserved');
  } finally { proxy.close(); sse.close(); }
});

test('上游宕机 → 502 JSON，且不影响另一上游', async () => {
  const alive = http.createServer((req, res) => { res.end('ALIVE'); });
  const pA = await listen(alive);
  const proxy = await startProxy({ frontPort: 0, ninferUpstream: '127.0.0.1:' + pA, bridgeUpstream: '127.0.0.1:1' });
  const pf = proxy.address().port;
  try {
    const r = await fetch('http://127.0.0.1:' + pf + '/metrics');
    assert.equal(r.status, 502);
    const b = JSON.parse(await r.text());
    assert.match(b.error.message, /bridge unreachable/);
    const r2 = await fetch('http://127.0.0.1:' + pf + '/health');
    assert.equal(r2.status, 200);
    assert.equal(await r2.text(), 'ALIVE');
  } finally { proxy.close(); alive.close(); }
});
