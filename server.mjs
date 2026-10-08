#!/usr/bin/env node
/**
 * vLLM 实时监控面板 — 零依赖 Node 服务（多实例版）
 *
 * 用法: node server.mjs
 * 环境变量:
 *   PORT        面板端口 (默认 8899)
 *   SCRAPE_MS   抓取间隔毫秒 (默认 500，仅作为初始值；界面可切 500/1000/2000)
 *
 * 实例列表持久化在同目录 config.json:
 *   { "targets": [ { "id", "name", "baseURL", "apiKey" } ] }
 *   metrics 端点自动取为 baseURL 域名根下的 /metrics；
 *   apiKey 非空时以 Authorization: Bearer 头发送。
 *   首次运行写入空实例列表，请自行添加 vLLM 端点。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8899);
const CONFIG_PATH = path.join(__dirname, 'config.json');

const HISTS = [
  'time_to_first_token_seconds',
  'inter_token_latency_seconds',
  'e2e_request_latency_seconds',
  'request_queue_time_seconds',
  'request_prefill_time_seconds',
  'request_decode_time_seconds',
];

// ---------- Prometheus 文本解析 ----------

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

function sumSeries(samples, name) {
  const arr = samples[name];
  if (!arr || !arr.length) return null;
  let t = 0;
  let any = false;
  for (const s of arr) if (isFinite(s.value)) { t += s.value; any = true; }
  return any ? t : null;
}

function histogram(samples, base) {
  const byLe = new Map();
  for (const s of samples[base + '_bucket'] || []) {
    const leRaw = s.labels.le;
    if (leRaw == null || !isFinite(s.value)) continue;
    const le = leRaw === '+Inf' ? Infinity : Number(leRaw);
    if (!Number.isFinite(le) && le !== Infinity) continue;
    byLe.set(le, (byLe.get(le) || 0) + s.value);
  }
  const buckets = [...byLe.entries()].sort((a, b) => a[0] - b[0]);
  const count = sumSeries(samples, base + '_count') ?? 0;
  const sum = sumSeries(samples, base + '_sum') ?? 0;
  return { buckets, count, sum, avg: count ? sum / count : null };
}

function percentile(buckets, count, q) {
  if (!count || count <= 0) return null;
  const target = q * count;
  let prevLe = 0;
  let prevCount = 0;
  for (const [le, c] of buckets) {
    if (c >= target) {
      if (le === Infinity) return null;
      const frac = (target - prevCount) / (c - prevCount || 1);
      return prevLe + (le - prevLe) * Math.min(Math.max(frac, 0), 1);
    }
    prevLe = le;
    prevCount = c;
  }
  return null;
}

function distinctLabel(samples, metric, key) {
  const set = new Set();
  for (const s of samples[metric] || []) if (s.labels[key] != null) set.add(s.labels[key]);
  return [...set];
}

// ---------- 快照构建 ----------

function buildSnapshot(samples) {
  const g = {
    running: sumSeries(samples, 'vllm:num_requests_running') ?? 0,
    waiting: sumSeries(samples, 'vllm:num_requests_waiting') ?? 0,
    kvPct: sumSeries(samples, 'vllm:kv_cache_usage_perc') ?? 0,
    preemptions: sumSeries(samples, 'vllm:num_preemptions_total') ?? 0,
    promptTokens: sumSeries(samples, 'vllm:prompt_tokens_total') ?? 0,
    generationTokens: sumSeries(samples, 'vllm:generation_tokens_total') ?? 0,
    cachedPromptTokens: sumSeries(samples, 'vllm:prompt_tokens_cached_total') ?? 0,
    residentMb: (sumSeries(samples, 'process_resident_memory_bytes') ?? 0) / 1048576,
  };
  const successByReason = {};
  let successTotal = 0;
  for (const s of samples['vllm:request_success_total'] || []) {
    const r = s.labels.finished_reason || 'unknown';
    successByReason[r] = s.value;
    successTotal += s.value;
  }
  const hist = {};
  for (const name of HISTS) {
    const h = histogram(samples, 'vllm:' + name);
    hist[name] = {
      count: h.count,
      avg: h.avg,
      p50: percentile(h.buckets, h.count, 0.5),
      p99: percentile(h.buckets, h.count, 0.99),
    };
  }
  const drafts = sumSeries(samples, 'vllm:spec_decode_num_draft_tokens_total');
  const accepted = sumSeries(samples, 'vllm:spec_decode_num_accepted_tokens_total');
  return {
    model: distinctLabel(samples, 'vllm:num_requests_running', 'model_name')[0] ?? null,
    engines: distinctLabel(samples, 'vllm:num_requests_running', 'engine'),
    gauges: g,
    successByReason,
    successTotal,
    specDecode: drafts ? { drafts, accepted: accepted ?? 0, acceptRate: (accepted ?? 0) / drafts } : null,
    hist,
  };
}

// ---------- 多实例管理 ----------

function metricsUrlFromBase(baseURL) {
  return new URL(baseURL).origin + '/metrics';
}

class Target {
  constructor(cfg) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.baseURL = cfg.baseURL;
    this.apiKey = cfg.apiKey || '';
    this.metricsUrl = metricsUrlFromBase(cfg.baseURL);
    this.history = []; // { ts, c } 最近两次抓取（用于实时速率）
    this.snap = { up: false, error: '尚未抓取', ts: Date.now() };
    this._stop = false;
  }

  // 实时速率：相邻两次抓取的差值（delta / 间隔秒数），无滑动窗口；计数器不动时精确为 0
  computeRates() {
    const h = this.history;
    if (h.length < 2) return null;
    const prev = h[h.length - 2];
    const cur = h[h.length - 1];
    if (cur.ts === prev.ts) return null;
    const dt = (cur.ts - prev.ts) / 1000;
    const r = (a, b) => (a == null || b == null || a < b) ? null : (a - b) / dt; // a<b = 计数器重置
    return {
      promptTokensPerS: r(cur.c.prompt, prev.c.prompt),
      generationTokensPerS: r(cur.c.generation, prev.c.generation),
      requestsPerS: r(cur.c.success, prev.c.success),
      preemptionsPerS: r(cur.c.preemptions, prev.c.preemptions),
    };
  }

  async scrapeOnce() {
    try {
      const headers = { 'user-agent': 'vllm-monitor/1.0' }; // 部分网关 WAF 会拦截空 UA
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const res = await fetch(this.metricsUrl, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const base = buildSnapshot(parseProm(text));
      const now = Date.now();
      const cur = {
        prompt: base.gauges.promptTokens,
        generation: base.gauges.generationTokens,
        success: base.successTotal,
        preemptions: base.gauges.preemptions,
      };
      this.history.push({ ts: now, c: cur });
      while (this.history.length > 2) this.history.shift(); // 只需保留最近两次（实时速率）
      this.snap = { up: true, error: null, ts: now, targetId: this.id, metricsUrl: this.metricsUrl, rates: this.computeRates(), ...base };
    } catch (e) {
      this.snap = { up: false, error: String(e?.message || e), ts: Date.now() };
    }
  }

  // 链式抓取：单次不重叠；远端响应慢时下一轮立即接上（以可持续的最高速率抓取）
  start() {
    (async () => {
      for (;;) {
        if (this._stop) return;
        const t0 = Date.now();
        await this.scrapeOnce();
        if (this._stop) return;
        const wait = scrapeMs - (Date.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    })();
  }

  stop() { this._stop = true; }

  public() {
    return {
      id: this.id, name: this.name, baseURL: this.baseURL, metricsUrl: this.metricsUrl,
      hasKey: !!this.apiKey, up: this.snap.up, error: this.snap.up ? null : this.snap.error, ts: this.snap.ts,
    };
  }
}

function loadConfig() {
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (c && Array.isArray(c.targets)) return c; // 尊重已有配置（包括空列表）
  } catch {}
  return { targets: [] }; // 无默认实例：请在 config.json 或界面中添加自己的 vLLM 端点
}
function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

const config = loadConfig();
let scrapeMs = Number(process.env.SCRAPE_MS || config.scrapeMs || 500); // 抓取/刷新间隔，可经 /api/interval 调整
if (config.scrapeMs == null) config.scrapeMs = scrapeMs;
const targets = new Map();
for (const cfg of config.targets) targets.set(cfg.id, new Target(cfg));
saveConfig(); // 首次运行落盘种子配置

function addTarget(cfg) {
  const t = new Target(cfg);
  targets.set(cfg.id, t);
  t.start();
  return t;
}
for (const t of targets.values()) t.start();

// ---------- HTTP 服务 ----------

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const PUB = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');

    if (u.pathname === '/api/targets' && req.method === 'GET') {
      return json(res, 200, [...targets.values()].map((t) => t.public()));
    }

    if (u.pathname === '/api/targets' && req.method === 'POST') {
      const body = await readBody(req);
      let parsed;
      try { parsed = new URL(String(body.baseURL || '').trim()); }
      catch { return json(res, 400, { error: 'baseURL 无效' }); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return json(res, 400, { error: 'baseURL 需为 http/https' });
      }
      const name = String(body.name || '').trim() || parsed.hostname;
      let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'instance';
      while (targets.has(id)) id += '-' + crypto.randomBytes(2).toString('hex');
      const cfg = { id, name, baseURL: parsed.toString(), apiKey: String(body.apiKey || '').trim() };
      config.targets.push(cfg);
      saveConfig();
      const t = addTarget(cfg);
      return json(res, 201, t.public());
    }

    let m = u.pathname.match(/^\/api\/targets\/([\w-]+)$/);
    if (m && req.method === 'DELETE') {
      const t = targets.get(m[1]);
      if (!t) return json(res, 404, { error: 'target not found' });
      t.stop();
      targets.delete(m[1]);
      config.targets = config.targets.filter((x) => x.id !== m[1]);
      saveConfig();
      return json(res, 200, { ok: true });
    }

    m = u.pathname.match(/^\/api\/snapshot\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const t = targets.get(m[1]);
      if (!t) return json(res, 404, { error: 'target not found' });
      return json(res, 200, t.snap);
    }

    if (u.pathname === '/api/targets/test' && req.method === 'POST') {
      // 试用一次抓取（不保存配置），用于诊断端点是否可达、鉴权是否正确
      const body = await readBody(req);
      let parsed;
      try { parsed = new URL(String(body.baseURL || '').trim()); }
      catch { return json(res, 200, { ok: false, error: 'baseURL 无效' }); }
      const metricsUrl = parsed.origin + '/metrics';
      const headers = { 'user-agent': 'vllm-monitor/1.0' };
      const key = String(body.apiKey || '').trim();
      if (key) headers.authorization = `Bearer ${key}`;
      try {
        const resp = await fetch(metricsUrl, { headers, signal: AbortSignal.timeout(15000) });
        if (!resp.ok) return json(res, 200, { ok: false, httpStatus: resp.status, error: `HTTP ${resp.status}（${key ? '密钥无效或该网关不允许匿名访问' : '可能需要 API Key'}）`, metricsUrl });
        const text = await resp.text();
        const samples = parseProm(text);
        const base = buildSnapshot(samples);
        return json(res, 200, {
          ok: true, metricsUrl, model: base.model,
          hasVllm: Object.keys(samples).some((k) => k.startsWith('vllm:')),
          bytes: text.length,
        });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e?.message || e) + '（DNS/网络/TLS 问题，或该网关未开放 /metrics）', metricsUrl });
      }
    }

    if (u.pathname === '/api/snapshot' && req.method === 'GET') {
      const t = targets.values().next().value; // 兼容旧接口
      return json(res, t ? 200 : 404, t ? t.snap : { up: false, error: 'no target' });
    }

    if (u.pathname === '/api/interval' && req.method === 'PUT') {
      const body = await readBody(req);
      const ms = Number(body.ms);
      if (![500, 1000, 2000].includes(ms)) {
        return json(res, 400, { error: 'ms 只能是 500 / 1000 / 2000' });
      }
      scrapeMs = ms;
      config.scrapeMs = ms;
      saveConfig();
      return json(res, 200, { ok: true, scrapeMs: scrapeMs });
    }

    if (u.pathname === '/api/health') {
      return json(res, 200, { ok: true, scrapeMs, targets: [...targets.values()].map((t) => t.public()) });
    }

    const file = path.normalize(path.join(PUB, u.pathname === '/' ? 'index.html' : u.pathname));
    if (!file.startsWith(PUB)) return json(res, 404, { error: 'not found' });
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    const status = e?.status || (e?.code === 'ENOENT' ? 404 : 500);
    json(res, status, { error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`vLLM 监控面板: http://127.0.0.1:${PORT}`);
  for (const t of targets.values()) {
    console.log(`  - ${t.name}: ${t.metricsUrl}${t.apiKey ? ' (带 API Key)' : ''} 每 ${scrapeMs}ms`);
  }
});
