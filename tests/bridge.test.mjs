// ninfer-bridge 测试：解析器、计数器折算、Prometheus 输出、CORS/鉴权。
// 运行: node --test tests/bridge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const BRIDGE = pathToFileURL(new URL('../ninfer-bridge.mjs', import.meta.url).pathname).href;

// 与 monitor.html / server.mjs 同款的最小 Prometheus 解析器（用于交叉验证）
function parseLabels(s) {
  const out = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/\\(.)/g, '$1');
  return out;
}
function parseProm(text) {
  const samples = {};
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(.+)$/);
    if (!m) continue;
    const [, name, labelStr, valStr] = m;
    const value = Number(valStr);
    if (Number.isNaN(value)) continue;
    const labels = labelStr ? parseLabels(labelStr) : {};
    (samples[name] ??= []).push({ labels, value });
  }
  return samples;
}

// 真实 nInfer 日志行（取自 journal / serve.log，含各种字段变体）
const L_WINDOW = '2026-11-14 14:11:02.496  INFO  throughput | 5.0s | prefill 5.73k tok/s (28,672 tok) | decode 43.6 tok/s (218 tok) | running 1 (prefill 1) | batch 1.00 | host 40.0% (2.0s)';
const L_WINDOW_DEC_ONLY = '2026-11-14 14:13:12.496  INFO  throughput | 5.0s | decode 100.2 tok/s (501 tok) | running 1 (decode-ready 1) | batch 1.00 | host 5.4% (268 ms)';
const L_WINDOW_IDLE = '2026-11-14 14:11:12.496  INFO  throughput | 5.0s | prefill 2.17k tok/s (10,860 tok) | decode 79.8 tok/s (399 tok) | running 0 | batch 1.00 | host 31.1% (1.6s)';
const L_DONE_MS = '2026-11-14 14:13:27.084  INFO  req#550 done | openai-chat | tool calls 1 | prompt 117,060 | output 6,194 | cache 115,936 (99.0%, private endpoint) | TTFT 623 ms | total 54.4s | queue 18.9 ms | prefill 1.97k tok/s | decode 115.2 tok/s | mtp accepted 3,887/9,240 (42.1%)';
const L_DONE_SEC = '2026-11-12 22:40:19.926  INFO  req#1 done | openai-chat | stop token | prompt 97,548 | output 160 | cache 0 (0.0%) | TTFT 23.3s | total 24.7s | queue 35.3 ms | prefill 4.20k tok/s | decode 116.9 tok/s | mtp accepted 99/240 (41.2%)';
const L_DONE_MIN = '2026-11-12 22:33:11.357  INFO  req#10 done | openai-chat | stop token | prompt 19,997 | output 1,110 | cache 19,466 (97.3%, long anchor) | TTFT 57.3s | total 1m 15.6s | queue 42.9 ms | prefill 10.9k tok/s | decode 163.4 tok/s | mtp accepted 68/112 (60.7%)';
const L_DONE_NOQUEUE = '2026-11-13 07:36:58.050  INFO  req#12 done | openai-chat | stop token | prompt 20,012 | output 201 | cache 0 (0.0%) | TTFT 1.9s | total 3.4s | prefill 10.4k tok/s | decode 137.1 tok/s | mtp accepted 132/280 (47.1%)';
const L_STARTED = '2026-11-14 14:10:59.044  INFO  req#538 started | openai-chat stream | 43 messages | max output 32,768 | thinking xhigh | tools 1 | preserve thinking';

test('parseRateTok / parseIntNum / parseDurS / mapReason', async () => {
  const { parseRateTok, parseIntNum, parseDurS, mapReason } = await requireBridge();
  assert.equal(parseRateTok('4.10k'), 4100);
  assert.equal(parseRateTok('926.0'), 926);
  assert.equal(parseRateTok('1.97k'), 1970);
  assert.equal(parseIntNum('7,436'), 7436);
  assert.equal(parseIntNum('117,060'), 117060);
  assert.equal(parseDurS('623 ms'), 0.623);
  assert.equal(parseDurS('23.3s'), 23.3);
  assert.equal(parseDurS('1m 15.6s'), 75.6);
  assert.equal(parseDurS('18.9 ms'), 0.0189);
  assert.equal(mapReason('stop token'), 'stop');
  assert.equal(mapReason('tool calls 1'), 'tool_calls');
  assert.equal(mapReason('length'), 'length');
  assert.equal(mapReason(''), 'unknown');
});

let bridgeMod = null;
async function requireBridge() {
  if (!bridgeMod) bridgeMod = await import(BRIDGE + '?t=1');
  return bridgeMod;
}

// 与 bridge 的 lineTs 完全一致的本地墙钟解析（测试与机器时区无关）
const tsOf = (s) => {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), m[7] ? Number(m[7].padEnd(3, '0')) : 0).getTime();
};

test('解析窗口行与 done 行：计数、直方图、inFlight', async () => {
  const { createBridgeState, resetHistState, handleLine, counterValue, runningNow, waitingNow } = await requireBridge();
  const st = createBridgeState();
  resetHistState(st);
  const tWin = tsOf(L_WINDOW); // 窗口 [tWin-5000, tWin]
  st.ninferUp = true; // 合成状态：视为服务器在线
  handleLine(st, L_STARTED, tWin - 5000);
  handleLine(st, L_WINDOW, tWin - 2000);
  assert.equal(st.inFlight, 1);
  assert.equal(st.lastWindow.running, 1);
  assert.equal(runningNow(st, tWin + 3000), 1);
  // 窗口折算：行到达后 5s 内线性放行 —— 3s 时计数 = 28672 × 0.6
  const promptMid = counterValue(st, 'prompt', tWin + 3000);
  assert.ok(Math.abs(promptMid - 28672 * 0.6) < 0.01, 'mid-window proration: ' + promptMid);
  const promptFull = counterValue(st, 'prompt', tWin + 6000);
  assert.ok(Math.abs(promptFull - 28672) < 0.001, 'full window: ' + promptFull);
  // 单调性：窗口过期折入 base 后取值不变
  assert.equal(counterValue(st, 'prompt', tWin + 40000), promptFull);

  handleLine(st, L_DONE_MS, tsOf(L_DONE_MS));
  assert.equal(st.inFlight, 0);
  assert.equal(st.successByReason.tool_calls, 1);
  assert.equal(st.base.cached, 115936);
  assert.equal(st.mtp.drafts, 9240);
  assert.equal(st.mtp.accepted, 3887);
  const ttft = st.hists.ttft;
  assert.equal(ttft.count, 1);
  assert.ok(Math.abs(ttft.sum - 0.623) < 1e-9);
  // 0.623s → le>=0.75 起累计 1
  const idx = [0.001,0.005,0.01,0.02,0.04,0.06,0.08,0.1,0.25,0.5,0.75,1.0,2.5,5.0,7.5,10.0,20.0,40.0,80.0,160.0,640.0,2560.0].findIndex((e) => e >= 0.623);
  for (let i = 0; i < ttft.buckets.length; i++) assert.equal(ttft.buckets[i], i >= idx ? 1 : 0);
  // e2e 54.4s → le>=60 起 1
  const e2e = st.hists.e2e;
  assert.equal(e2e.count, 1);
  assert.ok(Math.abs(e2e.sum - 54.4) < 1e-9);
  // itl 样本数 = min(output, 8192)
  assert.equal(st.hists.itl.count, 6194);

  // 其余变体
  handleLine(st, L_STARTED, tsOf(L_DONE_SEC) + 100000);
  handleLine(st, L_DONE_SEC, tsOf(L_DONE_SEC));
  handleLine(st, L_DONE_MIN, tsOf(L_DONE_MIN));
  handleLine(st, L_DONE_NOQUEUE, tsOf(L_DONE_NOQUEUE));
  assert.equal(st.inFlight, 0);
  assert.equal(st.successByReason.stop, 3);
  assert.equal(st.successByReason.tool_calls, 1);
  assert.equal(st.successTotal, 4);
  // 四条 done 都带 total → 4 个 e2e 样本
  assert.equal(st.hists.e2e.count, 4);
  assert.ok(Math.abs(st.hists.e2e.sum - (54.4 + 24.7 + 75.6 + 3.4)) < 1e-6);
  // queue 缺失不影响
  assert.equal(st.hists.queue.count, 3); // 三条带 queue 的行（MS/SEC/MIN），NOQUEUE 无
  assert.equal(waitingNow(st, tsOf(L_DONE_NOQUEUE) + 100000), 0);
});

test('promText：vLLM 命名、标签、分桶、页面解析器可还原', async () => {
  const { createBridgeState, resetHistState, handleLine, promText } = await requireBridge();
  const st = createBridgeState();
  resetHistState(st);
  const t0 = tsOf(L_WINDOW);
  handleLine(st, L_WINDOW, t0);
  handleLine(st, L_DONE_MS, t0 + 100000);
  handleLine(st, L_DONE_SEC, t0 + 200000);
  const now = t0 + 300000;
  const text = promText(st, now);
  const samples = parseProm(text);
  // 关键序列存在且带 model_name/engine 标签
  const running = samples['vllm:num_requests_running'];
  assert.ok(running && running.length === 1);
  assert.equal(running[0].labels.model_name, 'model');
  assert.equal(running[0].labels.engine, 'ninfer');
  // +Inf 桶 = count
  const inf = samples['vllm:time_to_first_token_seconds_bucket'].find((s) => s.labels.le === '+Inf');
  const cnt = samples['vllm:time_to_first_token_seconds_count'];
  assert.equal(inf.value, cnt[0].value);
  // TTFT avg = sum/count
  const sum = samples['vllm:time_to_first_token_seconds_sum'][0].value;
  assert.ok(Math.abs(sum / cnt[0].value - (0.623 + 23.3) / 2) < 1e-6);
  // 计数器：prompt 含完整窗口 28672
  const prompt = samples['vllm:prompt_tokens_total'][0].value;
  // 窗口 28,672 + 第一条 done 的缓存 115,936（vLLM 语义含缓存）
  assert.ok(Math.abs(prompt - (28672 + 115936)) < 0.001, 'prompt counter: ' + prompt);
  // 成功原因
  const ok = samples['vllm:request_success_total'];
  assert.ok(ok.some((s) => s.labels.finished_reason === 'tool_calls' && s.value === 1));
  assert.ok(ok.some((s) => s.labels.finished_reason === 'stop' && s.value === 1));
  // spec decode
  assert.equal(samples['vllm:spec_decode_num_draft_tokens_total'][0].value, 9480); // 9240 + 240
  assert.equal(samples['vllm:spec_decode_num_accepted_tokens_total'][0].value, 3986); // 3887 + 99
  // 直方图桶单调不减
  const b = samples['vllm:inter_token_latency_seconds_bucket'].filter((s) => s.labels.le !== '+Inf')
    .sort((a, b2) => Number(a.labels.le) - Number(b2.labels.le));
  for (let i = 1; i < b.length; i++) assert.ok(b[i].value >= b[i - 1].value, 'monotonic buckets');
});

test('HTTP：CORS 预检、鉴权、/metrics 与 /health', async () => {
  process.env.API_KEY = 'test-key-123';
  process.env.ALLOWED_ORIGINS = 'https://george-zmli.github.io';
  const { createBridgeState, resetHistState, handleLine, startServer } = await import(BRIDGE + '?http=1');
  const st = createBridgeState();
  resetHistState(st);
  handleLine(st, L_WINDOW, Date.now());
  handleLine(st, L_DONE_MS, Date.now());
  const server = await startServer(st, 0, '127.0.0.1');
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  try {
    // OPTIONS 预检：允许 Pages origin
    let r = await fetch(base + '/metrics', { method: 'OPTIONS', headers: { origin: 'https://george-zmli.github.io' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://george-zmli.github.io');
    assert.ok((r.headers.get('access-control-allow-headers') || '').includes('authorization'));
    // 恶意 origin 不回显
    r = await fetch(base + '/metrics', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    // localhost origin 放行
    r = await fetch(base + '/metrics', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:8899' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8899');
    // 鉴权
    r = await fetch(base + '/metrics');
    assert.equal(r.status, 401);
    r = await fetch(base + '/metrics', { headers: { authorization: 'Bearer wrong' } });
    assert.equal(r.status, 401);
    r = await fetch(base + '/metrics', { headers: { authorization: 'Bearer test-key-123', origin: 'https://george-zmli.github.io' } });
    assert.equal(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').startsWith('text/plain'));
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://george-zmli.github.io');
    const text = await r.text();
    assert.ok(text.includes('vllm:num_requests_running{model_name="model",engine="ninfer"}'));
    assert.ok(text.includes('ninfer_up 0')); // 未探测到 ninfer（本机 50217 可能有，但此处断言宽松）
    // /health 无需鉴权
    r = await fetch(base + '/health');
    assert.equal(r.status, 200);
    const h = await r.json();
    assert.equal(h.ok, true);
    assert.equal(h.linesSeen, 2);
  } finally {
    server.close();
    delete process.env.API_KEY;
  }
});

test('计数器严格单调（跨窗口折入边界无锯齿）', async () => {
  const { createBridgeState, resetHistState, handleLine, counterValue } = await requireBridge();
  const st = createBridgeState();
  resetHistState(st);
  // 三个先后到来的 5s 窗口
  const mk = (s) => '2026-11-14 ' + s + '  INFO  throughput | 5.0s | decode 100.0 tok/s (500 tok) | running 1 | batch 1.00 | host 5.0% (250 ms)';
  const t1 = tsOf(mk('10:00:00.000'));
  handleLine(st, mk('10:00:00.000'), t1);
  handleLine(st, mk('10:00:05.000'), t1 + 5000);
  handleLine(st, mk('10:00:10.000'), t1 + 10000);
  let prev = 0;
  // 以 250ms 步进扫过全部边界（含 30s 折入点 t1+30s 附近）
  for (let t = t1 - 5000; t <= t1 + 40000; t += 250) {
    const v = counterValue(st, 'generation', t);
    assert.ok(v >= prev - 1e-9, 'non-monotonic at t=' + (t - t1) + ': ' + prev + ' -> ' + v);
    prev = v;
  }
  assert.ok(Math.abs(prev - 1500) < 0.001, 'final total: ' + prev);
});
