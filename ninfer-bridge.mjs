#!/usr/bin/env node
/**
 * nInfer (capy-flash) → Prometheus /metrics 桥
 *
 * nInfer 的 ninfer-serve 没有 /metrics 端点（只有 OpenAI 兼容 API 和 /health），
 * 所以 vLLM 监控面板（vllm-monitor）抓不到它的速度。本桥在推理机本地运行，
 * 解析 nInfer 的日志（throughput 窗口行 + req#N done 行），
 * 输出 **vLLM 兼容命名**（vllm:*）的 Prometheus 文本，挂在独立端口上：
 *
 *     面板（GitHub Pages / Node 服务版） → http://<本机>:50218/metrics
 *
 * 面板代码零改动：把实例 baseURL 从 http://<ip>:50217/v1 改成 http://<ip>:50218/v1
 * （/metrics 由面板自动取 origin 根路径），API Key 不变即可。
 *
 * 日志来源（二选一，自动探测）：
 *   LOG_FILE=/path/to/serve.log      tail 文件（500ms 轮询，支持截断/轮转）
 *   JOURNAL_TAG=runvllm.sh.desktop   journalctl -t <tag>（GNOME .desktop 自启动的
 *                                    ninfer-serve 默认把日志写进 systemd journal，
 *                                    identifier 就是 .desktop 文件名）
 * 默认：LOG_FILE 未设时走 journal，tag 默认 runvllm.sh.desktop。
 *
 * 其它环境变量：
 *   PORT=50218            桥端口
 *   HOST=0.0.0.0          监听地址
 *   NINFER_URL=http://127.0.0.1:50217   用于 /health 存活探测（带 API Key）
 *   MODEL_NAME=model      输出到 model_name 标签
 *   API_KEY=...           设置后 /metrics 需要 Authorization: Bearer <key>
 *   API_KEY_FILE=...      从文件第一行读 key
 *   ALLOWED_ORIGINS=https://george-zmli.github.io   CORS 允许的来源（逗号分隔）；
 *                                           127.0.0.1/localhost 永远放行
 *
 * 零依赖，Node ≥ 18。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, openSync, closeSync, readSync, readdirSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------- 配置 ----------

const PORT = Number(process.env.PORT || 50218);
const HOST = process.env.HOST || '0.0.0.0';
const LOG_FILE = process.env.LOG_FILE || '';
const JOURNAL_TAG = process.env.JOURNAL_TAG || 'runvllm.sh.desktop';
const NINFER_URL = (process.env.NINFER_URL || 'http://127.0.0.1:50217').replace(/\/+$/, '');
const MODEL_NAME = process.env.MODEL_NAME || 'model';
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://george-zmli.github.io')
    .split(',').map((s) => s.trim()).filter(Boolean),
);
let API_KEY = (process.env.API_KEY || '').trim();
if (!API_KEY && process.env.API_KEY_FILE) {
  try { API_KEY = (readFileSync(process.env.API_KEY_FILE, 'utf8').split('\n')[0] || '').trim(); }
  catch { /* 忽略 */ }
}

const WINDOW_MS = 5000;      // nInfer throughput 行固定 5.0s 窗口
const ITL_CAP = 8192;        // 每请求最多计入的 ITL 样本数（大输出时近似）
const HEALTH_POLL_MS = 5000;

// ---------- vLLM 0.32 的直方图分桶（vllm/v1/metrics/buckets.py） ----------

const TTFT_BUCKETS = [0.001, 0.005, 0.01, 0.02, 0.04, 0.06, 0.08, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0, 20.0, 40.0, 80.0, 160.0, 640.0, 2560.0];
const REQ_LAT_BUCKETS = [0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 2.5, 5.0, 10.0, 15.0, 20.0, 30.0, 40.0, 50.0, 60.0, 120.0, 240.0, 480.0, 960.0, 1920.0, 7680.0];
const ITL_BUCKETS = [0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0, 20.0, 40.0, 80.0];

const HISTS = {
  ttft:    { name: 'vllm:time_to_first_token_seconds', help: 'Time to first token in seconds.', buckets: TTFT_BUCKETS },
  e2e:     { name: 'vllm:e2e_request_latency_seconds', help: 'E2E request latency in seconds.', buckets: REQ_LAT_BUCKETS },
  queue:   { name: 'vllm:request_queue_time_seconds', help: 'Request queue time in seconds.', buckets: REQ_LAT_BUCKETS },
  prefill: { name: 'vllm:request_prefill_time_seconds', help: 'Request prefill time in seconds.', buckets: REQ_LAT_BUCKETS },
  decode:  { name: 'vllm:request_decode_time_seconds', help: 'Request decode time in seconds.', buckets: REQ_LAT_BUCKETS },
  itl:     { name: 'vllm:inter_token_latency_seconds', help: 'Inter-token latency in seconds.', buckets: ITL_BUCKETS },
};

// ---------- 数值解析 ----------

/** "4.10k" / "926.0" → 4100 / 926 */
export function parseRateTok(s) {
  if (s == null) return null;
  const str = String(s).trim();
  const k = /k$/i.test(str);
  const v = Number(str.replace(/k$/i, '').replace(/,/g, ''));
  if (!isFinite(v)) return null;
  return k ? v * 1000 : v;
}

/** "7,436" → 7436 */
export function parseIntNum(s) {
  if (s == null) return null;
  const v = Number(String(s).replace(/,/g, ''));
  return isFinite(v) ? v : null;
}

/** "623 ms" / "23.3s" / "1m 15.6s" → 秒（number） */
export function parseDurS(s) {
  if (s == null) return null;
  const str = String(s).trim();
  let ms = null;
  let m = str.match(/^([\d.]+)\s*ms$/);
  if (m) ms = parseFloat(m[1]);
  else if ((m = str.match(/^([\d.]+)\s*s$/))) ms = parseFloat(m[1]) * 1000;
  else if ((m = str.match(/^(\d+)m\s+([\d.]+)s$/))) ms = Number(m[1]) * 60000 + parseFloat(m[2]) * 1000;
  return ms == null ? null : ms / 1000;
}

/** nInfer 的结束原因 → vLLM finished_reason 标签 */
export function mapReason(raw) {
  const r = String(raw || '').trim();
  if (r === 'stop token' || r === 'stop') return 'stop';
  if (/^tool calls/i.test(r)) return 'tool_calls';
  if (r === 'length' || r === 'output limit' || r === 'max tokens') return 'length';
  if (/^error/i.test(r)) return 'error';
  if (r === 'cancelled' || r === 'canceled' || r === 'aborted') return 'abort';
  return r || 'unknown';
}

/** 行首时间戳 "2026-11-14 14:10:47.496" → epoch ms（本地时区） */
function lineTs(line) {
  const m = line.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms).getTime();
  return isFinite(t) ? t : null;
}

// ---------- 桥状态 ----------

export function createBridgeState() {
  return {
    startedAt: Date.now(),
    // 累计计数（自桥启动/回填起）
    base: { prompt: 0, generation: 0, cached: 0 },
    pending: { prompt: [], generation: [] },   // 未走完的 5s 窗口 {n, start, end}
    successByReason: {},
    successTotal: 0,
    mtp: { drafts: 0, accepted: 0 },
    hists: {},
    inFlight: 0,                               // started 且未 done 的请求数
    lastWindow: null,                          // { ts, running, batch, host }
    lastLineAt: null,
    lastLineKind: null,
    ninferUp: false,
    ninferCheckAt: 0,
    rssBytes: 0,
    rssAt: 0,
    logSource: null,                           // 'file:<path>' | 'journal:<tag>' | 'none'
    logError: null,
    linesSeen: 0,
  };
}

export function resetHistState(state) {
  for (const key of Object.keys(HISTS)) {
    state.hists[key] = { count: 0, sum: 0, buckets: new Array(HISTS[key].buckets.length).fill(0) };
  }
}

/** 记一个直方图样本（value 秒；n 个相同样本一次记入） */
export function addSample(state, key, value, n = 1) {
  if (value == null || !isFinite(value) || value < 0 || n <= 0) return;
  const h = state.hists[key];
  if (!h) return;
  h.count += n;
  h.sum += value * n;
  const edges = HISTS[key].buckets;
  for (let i = 0; i < edges.length; i++) if (value <= edges[i]) h.buckets[i] += n;
}

/**
 * 窗口行在窗口**结束**时才打印（ts = 窗口末），此刻 token 数已完整。
 * 若在到达瞬间全额计入，计数器是阶跃的（面板速率忽高忽低）。
 * 因此把这笔 token 额在**到达后的 5s** 内线性放行：
 * 计数器以窗口速率匀速上涨，页面 delta/dt 在任意轮询频率下都平滑且精确。
 */
function pushWindow(state, kind, n, endTs) {
  if (n == null || n <= 0) return;
  state.pending[kind].push({ n, start: endTs, end: endTs + WINDOW_MS });
}

/** 当前累计值：base + 未走完窗口按时间线性折算（严格单调，面板速率平滑） */
export function counterValue(state, kind, now) {
  const pend = state.pending[kind];
  // 先在 base 里折入所有过期窗口，再从头累加 —— 顺序错误会造成计数器锯齿（见测试）
  for (let i = pend.length - 1; i >= 0; i--) {
    if (pend[i].end < now - 30000) {
      state.base[kind] += pend[i].n;
      pend.splice(i, 1);
    }
  }
  let v = state.base[kind];
  for (const w of pend) {
    const frac = Math.min(Math.max((now - w.start) / (w.end - w.start), 0), 1);
    v += w.n * frac;
  }
  return v;
}

// ---------- 日志行解析 ----------

/** 处理一行 nInfer 日志（throughput 窗口行 / req#N started / req#N done） */
export function handleLine(state, line, now = Date.now()) {
  if (typeof line !== 'string' || !line.length) return;
  const ts = lineTs(line) ?? now;
  if (line.includes('throughput |')) {
    const mp = line.match(/prefill ([\d.]+)k? tok\/s \(([\d,]+) tok\)/);
    const md = line.match(/decode ([\d.]+)k? tok\/s \(([\d,]+) tok\)/);
    const mr = line.match(/running (\d+)/);
    const mb = line.match(/batch ([\d.]+)/);
    const mh = line.match(/host ([\d.]+)%/);
    const prev = state.lastWindow || {};
    state.lastWindow = {
      ts,
      running: mr ? Number(mr[1]) : (prev.running ?? 0),
      batch: mb ? Number(mb[1]) : prev.batch,
      host: mh ? Number(mh[1]) : prev.host,
    };
    if (mp) pushWindow(state, 'prompt', parseIntNum(mp[2]), ts);
    if (md) pushWindow(state, 'generation', parseIntNum(md[2]), ts);
    state.lastLineAt = ts;
    state.lastLineKind = 'window';
    state.linesSeen++;
    return;
  }

  if (/req#\d+ started/.test(line)) {
    state.inFlight++;
    state.lastLineAt = ts;
    state.lastLineKind = 'started';
    state.linesSeen++;
    return;
  }

  if (/req#\d+ done/.test(line)) {
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.lastLineAt = ts;
    state.lastLineKind = 'done';
    state.linesSeen++;

    let m;
    const grab = (re) => { m = line.match(re); return m ? m[1] : null; };
    const reason = mapReason(grab(/req#\d+ done \| [^|]*\| ([^|]+) \|/));
    const prompt = parseIntNum(grab(/ prompt ([\d,]+) \|/));
    const output = parseIntNum(grab(/ output ([\d,]+) \|/));
    const cache = parseIntNum(grab(/ cache ([\d,]+) \(/));
    const ttft = parseDurS(grab(/ TTFT ([^|]+) \|/));
    const total = parseDurS(grab(/ total ([^|]+) \|/));
    const queue = parseDurS(grab(/ queue ([^|]+) \|/));
    const prefillRate = parseRateTok(grab(/ prefill ([\d.]+k?) tok\/s \|/));
    const decodeRate = parseRateTok(grab(/ decode ([\d.]+k?) tok\/s \|/));
    const mtp = line.match(/mtp accepted ([\d,]+)\/([\d,]+) /);

    state.successByReason[reason] = (state.successByReason[reason] || 0) + 1;
    state.successTotal++;
    if (cache) { state.base.cached += cache; state.base.prompt += cache; } // vLLM 语义：prompt 计数含缓存部分
    if (mtp) {   // 日志格式 "mtp accepted A/D"：A=接受数，D=提出的草稿数
      state.mtp.accepted += parseIntNum(mtp[1]) || 0;
      state.mtp.drafts += parseIntNum(mtp[2]) || 0;
    }
    if (ttft != null) addSample(state, 'ttft', ttft);
    if (total != null) addSample(state, 'e2e', total);
    if (queue != null) addSample(state, 'queue', queue);
    if (prompt && prefillRate) addSample(state, 'prefill', prompt / prefillRate);
    if (output && decodeRate) addSample(state, 'decode', output / decodeRate);
    if (output && decodeRate) addSample(state, 'itl', 1 / decodeRate, Math.min(output, ITL_CAP));
  }
}

// ---------- 派生量 ----------

export function runningNow(state, now) {
  // 服务器已探明离线（10s 内有探测且失败）→ 强制 0
  if (state.ninferCheckAt && !state.ninferUp && now - state.ninferCheckAt < 10000) return 0;
  // inFlight = started 未 done 的请求数：为 0 表示系统内无请求，running 必为 0
  if (state.inFlight <= 0) return 0;
  const r = state.lastWindow ? state.lastWindow.running : 0;
  return Math.max(1, r); // 新请求可能还没被最近的 5s 窗口捕获
}

export function waitingNow(state, now) {
  if (state.inFlight <= 0) return 0;
  if (state.ninferCheckAt && !state.ninferUp && now - state.ninferCheckAt < 10000) return 0;
  return Math.max(0, state.inFlight - runningNow(state, now));
}

/** 找 ninfer-serve 进程的 RSS（best effort，5s 缓存） */
export function probeNinferRss() {
  let pids;
  try { pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p)); }
  catch { return null; }
  for (const pid of pids) {
    try {
      const cmd = readFileSync('/proc/' + pid + '/cmdline', 'utf8');
      if (!cmd.includes('ninfer-serve')) continue;
      const st = readFileSync('/proc/' + pid + '/status', 'utf8');
      const m = st.match(/VmRSS:\s+(\d+) kB/);
      if (m) return Number(m[1]) * 1024;
    } catch { /* 进程可能消失 */ }
  }
  return null;
}

// ---------- Prometheus 文本 ----------

function fmt(v) { return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '0'; }

export function promText(state, now = Date.now()) {
  const lab = `${'{'}model_name="${MODEL_NAME}",engine="ninfer"${'}'}`;
  const labR = (r) => `${'{'}model_name="${MODEL_NAME}",engine="ninfer",finished_reason="${r}"${'}'}`;
  const L = [];
  const h = (help, type) => L.push('# HELP ninfer_bridge ' + help, '# TYPE ninfer_bridge ' + type);

  L.push('# HELP ninfer_up 1 when the nInfer /health probe answered.', '# TYPE ninfer_up gauge');
  L.push('ninfer_up ' + (state.ninferUp ? 1 : 0));
  L.push('# HELP ninfer_requests_in_flight Requests started but not finished.', '# TYPE ninfer_requests_in_flight gauge');
  L.push('ninfer_requests_in_flight ' + state.inFlight);
  L.push('# HELP ninfer_batch_size Last batch size from the throughput window.', '# TYPE ninfer_batch_size gauge');
  L.push('ninfer_batch_size ' + fmt(state.lastWindow ? state.lastWindow.batch ?? 0 : 0));
  L.push('# HELP ninfer_host_busy_percent Last host CPU busy percent from the throughput window.', '# TYPE ninfer_host_busy_percent gauge');
  L.push('ninfer_host_busy_percent ' + fmt(state.lastWindow ? state.lastWindow.host ?? 0 : 0));
  L.push('# HELP ninfer_last_log_age_seconds Age of the last parsed log line.', '# TYPE ninfer_last_log_age_seconds gauge');
  L.push('ninfer_last_log_age_seconds ' + fmt(state.lastLineAt ? (now - state.lastLineAt) / 1000 : 0));
  L.push('# HELP ninfer_bridge_uptime_seconds Bridge uptime.', '# TYPE ninfer_bridge_uptime_seconds gauge');
  L.push('ninfer_bridge_uptime_seconds ' + fmt((now - state.startedAt) / 1000));

  L.push('# HELP process_resident_memory_bytes Resident memory of the ninfer-serve process.', '# TYPE process_resident_memory_bytes gauge');
  L.push('process_resident_memory_bytes ' + Math.round(state.rssBytes || 0));

  L.push('# HELP vllm:num_requests_running Number of requests currently running (nInfer: requests in flight).', '# TYPE vllm:num_requests_running gauge');
  L.push('vllm:num_requests_running' + lab + ' ' + runningNow(state, now));
  L.push('# HELP vllm:num_requests_waiting Number of requests waiting (nInfer: accepted beyond the running count).', '# TYPE vllm:num_requests_waiting gauge');
  L.push('vllm:num_requests_waiting' + lab + ' ' + waitingNow(state, now));
  L.push('# HELP vllm:num_preemptions_total Cumulative preemptions (nInfer does not preempt).', '# TYPE vllm:num_preemptions_total counter');
  L.push('vllm:num_preemptions_total' + lab + ' 0');
  L.push('# HELP vllm:prompt_tokens_total Cumulative prompt tokens (prefill work from 5s windows + cached portion per finished request, vLLM semantics).', '# TYPE vllm:prompt_tokens_total counter');
  L.push('vllm:prompt_tokens_total' + lab + ' ' + fmt(counterValue(state, 'prompt', now)));
  L.push('# HELP vllm:generation_tokens_total Cumulative generated tokens (integrated from 5s windows).', '# TYPE vllm:generation_tokens_total counter');
  L.push('vllm:generation_tokens_total' + lab + ' ' + fmt(counterValue(state, 'generation', now)));
  L.push('# HELP vllm:prompt_tokens_cached_total Cumulative cached prompt tokens.', '# TYPE vllm:prompt_tokens_cached_total counter');
  L.push('vllm:prompt_tokens_cached_total' + lab + ' ' + Math.round(state.base.cached));

  L.push('# HELP vllm:request_success_total Cumulative finished requests by reason.', '# TYPE vllm:request_success_total counter');
  const reasons = Object.keys(state.successByReason).sort();
  for (const r of reasons) L.push('vllm:request_success_total' + labR(r) + ' ' + state.successByReason[r]);
  if (!reasons.length) L.push('vllm:request_success_total' + labR('unknown') + ' 0');

  for (const key of Object.keys(HISTS)) {
    const def = HISTS[key];
    const hs = state.hists[key] || { count: 0, sum: 0, buckets: def.buckets.map(() => 0) };
    L.push('# HELP ' + def.name + ' ' + def.help, '# TYPE ' + def.name + ' histogram');
    const labLe = (le) => `${'{'}model_name="${MODEL_NAME}",engine="ninfer",le="${le}"${'}'}`;
    for (let i = 0; i < def.buckets.length; i++) {
      L.push(def.name + '_bucket' + labLe(def.buckets[i]) + ' ' + hs.buckets[i]);
    }
    L.push(def.name + '_bucket' + labLe('+Inf') + ' ' + hs.count);
    L.push(def.name + '_sum' + lab + ' ' + fmt(hs.sum));
    L.push(def.name + '_count' + lab + ' ' + hs.count);
  }

  if (state.mtp.drafts > 0) {
    L.push('# HELP vllm:spec_decode_num_draft_tokens_total Cumulative draft tokens proposed (nInfer MTP).', '# TYPE vllm:spec_decode_num_draft_tokens_total counter');
    L.push('vllm:spec_decode_num_draft_tokens_total' + lab + ' ' + state.mtp.drafts);
    L.push('# HELP vllm:spec_decode_num_accepted_tokens_total Cumulative accepted tokens (nInfer MTP).', '# TYPE vllm:spec_decode_num_accepted_tokens_total counter');
    L.push('vllm:spec_decode_num_accepted_tokens_total' + lab + ' ' + state.mtp.accepted);
  }
  return L.join('\n') + '\n';
}

// ---------- 日志源 ----------

class FileTail {
  constructor(file, onLine, backfillBytes = 512 * 1024) {
    this.file = file; this.onLine = onLine;
    this.backfillBytes = backfillBytes;
    this.pos = 0; this.buf = ''; this.timer = null; this.ready = false;
  }
  async start() {
    const st = statSync(this.file);
    this.pos = Math.max(0, st.size - this.backfillBytes);
    let chunk = '';
    if (st.size > this.pos) {
      const fd = openSync(this.file, 'r');
      const n = Math.min(st.size - this.pos, this.backfillBytes);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, this.pos);
      closeSync(fd);
      this.pos = st.size;
      chunk = buf.toString('utf8');
    }
    if (chunk) {
      const lines = chunk.split('\n');
      this.buf = lines.pop() || '';
      for (const l of lines) if (l) this.onLine(l); // 首行可能是截断行，交给解析器容错
    }
    this.timer = setInterval(() => this.poll(), 400);
    this.ready = true;
  }
  poll() {
    let st;
    try { st = statSync(this.file); } catch { return; }
    if (st.size < this.pos) this.pos = 0;            // 截断/轮转
    if (st.size <= this.pos) return;
    let data;
    try {
      const fd = openSync(this.file, 'r');
      const n = Math.min(st.size - this.pos, 16 * 1024 * 1024);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, this.pos);
      closeSync(fd);
      this.pos += n;
      data = buf.toString('utf8');
    } catch { return; }
    let s = this.buf + data;
    const lines = s.split('\n');
    this.buf = lines.pop() || '';
    for (const l of lines) if (l) this.onLine(l);
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}

class JournalTail {
  constructor(tag, onLine, backfillLines = 2000) {
    this.tag = tag; this.onLine = onLine; this.backfillLines = backfillLines;
    this.child = null; this.buf = ''; this.ready = false;
  }
  async start() {
    // 回填：最近 N 行
    try {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync('journalctl', ['-o', 'cat', '-n', String(this.backfillLines), '-t', this.tag, '--no-pager'], { encoding: 'utf8', timeout: 15000 });
      for (const l of out.split('\n')) if (l) this.onLine(l);
    } catch (e) {
      throw new Error('journalctl 回填失败: ' + String(e.message || e).split('\n')[0]);
    }
    // 跟随
    this.child = spawn('journalctl', ['-o', 'cat', '-f', '-t', this.tag, '--no-pager'], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      this.buf += d;
      const lines = this.buf.split('\n');
      this.buf = lines.pop() || '';
      for (const l of lines) if (l) this.onLine(l);
    });
    this.child.stderr.on('data', () => {});
    this.child.on('exit', (code) => {
      // journalctl 异常退出（如 tag 变化）：1s 后重连
      setTimeout(() => { if (!this._stopped) this.follow(); }, 1000);
    });
    this.follow = () => {
      const c = spawn('journalctl', ['-o', 'cat', '-f', '-t', this.tag, '--no-pager'], { stdio: ['ignore', 'pipe', 'pipe'] });
      c.stdout.setEncoding('utf8');
      c.stdout.on('data', (d) => { this.buf += d; const ls = this.buf.split('\n'); this.buf = ls.pop() || ''; for (const l of ls) if (l) this.onLine(l); });
      c.stderr.on('data', () => {});
      c.on('exit', (code) => { setTimeout(() => { if (!this._stopped) this.follow(); }, 1000); });
      this.child = c;
    };
    this.ready = true;
  }
  stop() { this._stopped = true; try { this.child && this.child.kill(); } catch {} }
}

// ---------- HTTP 服务 ----------

function corsOk(origin) {
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  if (host === '127.0.0.1' || host === 'localhost') return true;
  return ALLOWED_ORIGINS.has(origin);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (corsOk(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.setHeader('access-control-max-age', '86400');
}

function authOk(req) {
  if (!API_KEY) return true;
  const got = String(req.headers.authorization || '');
  const want = 'Bearer ' + API_KEY;
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(res, code, obj, req) {
  applyCors(req, res);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

export function startServer(state, port = PORT, host = HOST) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      const now = Date.now();
      if (req.method === 'OPTIONS') {
        applyCors(req, res);
        res.writeHead(204, { 'content-length': '0' });
        return res.end();
      }
      if (u.pathname === '/metrics') {
        if (!authOk(req)) {
          return json(res, 401, { error: { message: 'missing or invalid API key', type: 'invalid_request_error' } }, req);
        }
        res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        applyCors(req, res);
        return res.end(promText(state, now));
      }
      if (u.pathname === '/health' || u.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          ninferUp: state.ninferUp,
          ninferUrl: NINFER_URL,
          logSource: state.logSource,
          logError: state.logError,
          linesSeen: state.linesSeen,
          lastLineAt: state.lastLineAt,
          inFlight: state.inFlight,
          running: runningNow(state, now),
          waiting: waitingNow(state, now),
          successTotal: state.successTotal,
          startedAt: state.startedAt,
        }, req);
      }
      if (u.pathname === '/' || u.pathname === '/index.html') {
        const body = '<!doctype html><meta charset="utf-8"><title>ninfer-bridge</title>'
          + '<body style="font:14px ui-monospace,monospace;padding:24px">'
          + '<h2>ninfer-bridge</h2><pre id="s">…</pre><script>async function f(){try{const r=await fetch(\'/health\');document.getElementById(\'s\').textContent=JSON.stringify(await r.json(),null,2)}catch(e){document.getElementById(\'s\').textContent=String(e)}}f();setInterval(f,3000)</script>';
        applyCors(req, res);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(body);
      }
      json(res, 404, { error: 'not found' }, req);
    } catch (e) {
      try { json(res, 500, { error: String(e?.message || e) }, req); } catch {}
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

// ---------- 主流程 ----------

async function main() {
  const state = createBridgeState();
  resetHistState(state);

  const onLine = (line) => handleLine(state, line);

  // 日志源
  let tail = null;
  if (LOG_FILE) {
    try {
      statSync(LOG_FILE);
      tail = new FileTail(LOG_FILE, onLine);
      await tail.start();
      state.logSource = 'file:' + LOG_FILE;
    } catch (e) {
      state.logError = 'LOG_FILE 不可用: ' + String(e.message || e);
      console.error('[ninfer-bridge] ' + state.logError + '，回退 journal');
    }
  }
  if (!tail) {
    try {
      tail = new JournalTail(JOURNAL_TAG, onLine);
      await tail.start();
      state.logSource = 'journal:' + JOURNAL_TAG;
    } catch (e) {
      state.logError = String(e.message || e);
      console.error('[ninfer-bridge] 日志源不可用: ' + state.logError);
      state.logSource = 'none';
    }
  }

  // ninfer /health 存活 + 进程 RSS
  const liveness = async () => {
    try {
      const headers = { 'user-agent': 'ninfer-bridge/1.0' };
      if (API_KEY) headers.authorization = 'Bearer ' + API_KEY;
      const res = await fetch(NINFER_URL + '/health', { headers, signal: AbortSignal.timeout(3000) });
      state.ninferUp = res.ok;
    } catch { state.ninferUp = false; }
    state.ninferCheckAt = Date.now();
    try {
      const rss = probeNinferRss();
      if (rss != null) { state.rssBytes = rss; state.rssAt = Date.now(); }
    } catch {}
  };
  await liveness();
  setInterval(liveness, HEALTH_POLL_MS);

  const server = await startServer(state);
  console.log('[ninfer-bridge] 监听 http://' + (HOST === '0.0.0.0' ? '0.0.0.0' : HOST) + ':' + PORT
    + '  /metrics（vLLM 兼容命名）  日志源=' + state.logSource
    + '  key=' + (API_KEY ? '已配置' : '未配置（/metrics 匿名）')
    + '  CORS=' + [...ALLOWED_ORIGINS].join(','));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
    try { tail && tail.stop(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[ninfer-bridge] fatal:', e); process.exit(1); });
}
