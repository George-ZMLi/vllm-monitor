/* vLLM 监控面板前端 — 多实例版：轮询 /api/snapshot/<id>，按实例保留历史，canvas 绘图，零依赖 */
(() => {
const MAX = 2400; // 每实例保留 2400 个采样点
const INTERVALS = [500, 1000, 2000]; // 支持的刷新间隔（与后端抓取间隔同步）
let intervalMs = INTERVALS.includes(Number(localStorage.getItem('vllm.interval')))
  ? Number(localStorage.getItem('vllm.interval')) : 500;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 每个实例独立的历史序列
const store = new Map();
const getStore = (id) => {
  if (!store.has(id)) store.set(id, { running: [], waiting: [], kv: [], gen: [], prompt: [], ttftP50: [], e2eP99: [] });
  return store.get(id);
};
const push = (arr, v) => { arr.push(v); if (arr.length > MAX) arr.shift(); };

let targets = [];
let activeId = localStorage.getItem('vllm.active');
const dotEls = new Map();

const CHARTS = [
  { cv: 'c1', lg: 'lg1', unit: '', fixed: false, series: [
    { label: 'running', color: '#4d7fd6', key: 'running', fmt: fmtN },
    { label: 'waiting', color: '#e09b3f', key: 'waiting', fmt: fmtN } ] },
  { cv: 'c2', lg: 'lg2', unit: '%', fixed: 100, series: [
    { label: 'kv_cache', color: '#8a76d9', key: 'kv', fmt: (v) => v == null ? '–' : v.toFixed(1) } ] },
  { cv: 'c3', lg: 'lg3', unit: 'tok/s', fixed: false, series: [
    { label: 'generation', color: '#2f9e77', key: 'gen', fmt: fmtN },
    { label: 'prompt', color: '#59a8dc', key: 'prompt', fmt: fmtN } ] },
  { cv: 'c4', lg: 'lg4', unit: 's', fixed: false, series: [
    { label: 'TTFT p50', color: '#d6709a', key: 'ttftP50', fmt: fmtS },
    { label: 'E2E p99', color: '#7c6fd0', key: 'e2eP99', fmt: fmtS } ] },
];

function fmtN(v) {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 100) return String(Math.round(v));
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
function fmtS(v) {
  if (v == null || !isFinite(v)) return '–';
  if (v < 1) return Math.round(v * 1000) + ' ms';
  return v.toFixed(2) + ' s';
}
function shortVal(v) {
  if (v >= 1e4) return Math.round(v / 1e3) + 'k';
  if (v >= 100) return String(Math.round(v));
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(2);
}
function setNum(id, text) {
  const el = $(id);
  if (el.firstChild && el.firstChild.nodeType === 3) el.firstChild.nodeValue = text;
  else el.textContent = text;
}
const activeName = () => (targets.find((t) => t.id === activeId) || {}).name || '';

// ---------- 图表 ----------

function draw(c) {
  const st = getStore(activeId);
  const series = c.series.map((s) => ({ ...s, data: st[s.key] }));
  const cv = $(c.cv);
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 600, h = cv.clientHeight || 220;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const padL = 46, padR = 10, padT = 10, padB = 24;
  const pw = w - padL - padR, ph = h - padT - padB;
  let yMax = c.fixed;
  if (!c.fixed) {
    yMax = 0;
    for (const s of series) for (const v of s.data) if (v != null && isFinite(v)) yMax = Math.max(yMax, v);
    yMax = Math.max(yMax * 1.15, 0.5);
  }
  const Y = (v) => padT + ph * (1 - Math.min(Math.max(v / yMax, 0), 1));
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = padT + ph * (i / 4);
    ctx.strokeStyle = 'rgba(34, 54, 79, .08)';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = 'rgba(129, 149, 176, .9)';
    const val = yMax * (1 - i / 4);
    ctx.fillText(c.unit === '%' ? Math.round(val) + '%' : shortVal(val), padL - 6, y);
  }
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(129, 149, 176, .8)';
  const mins = Math.round(MAX * intervalMs / 60000);
  ctx.textAlign = 'left';
  ctx.fillText('-' + mins + 'm', padL, h - padB + 8);
  ctx.textAlign = 'right';
  ctx.fillText('now', w - padR, h - padB + 8);
  // 折线（右对齐窗口，null = 缺数据断开；点数过多按像素抽稀）
  const maxPts = Math.max(2, Math.floor(pw / 2));
  for (const s of series) {
    const vals = s.data.slice(-MAX);
    const pad = MAX - vals.length;
    const step = Math.max(1, Math.ceil(vals.length / maxPts));
    const idx = [];
    for (let i = 0; i < vals.length; i += step) idx.push(i);
    if (idx[idx.length - 1] !== vals.length - 1) idx.push(vals.length - 1); // 末端点必画
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (const i of idx) {
      const v = vals[i];
      if (v == null || !isFinite(v)) { started = false; continue; }
      const x = padL + pw * ((i + pad) / (MAX - 1));
      if (!started) { ctx.moveTo(x, Y(v)); started = true; }
      else ctx.lineTo(x, Y(v));
    }
    ctx.stroke();
  }
}

function legend(c) {
  const st = getStore(activeId);
  const el = $(c.lg);
  el.innerHTML = c.series.map((s) => {
    const arr = st[s.key];
    let last = null;
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && isFinite(arr[i])) { last = arr[i]; break; }
    return `<span><i class="sw" style="background:${s.color}"></i>${s.label} <b>${s.fmt(last)}</b></span>`;
  }).join('');
}

// ---------- 渲染 ----------

function render(s) {
  const st = getStore(activeId);
  if (s.up) {
    push(st.running, s.gauges.running);
    push(st.waiting, s.gauges.waiting);
    push(st.kv, s.gauges.kvPct);
    push(st.gen, s.rates?.generationTokensPerS ?? null);
    push(st.prompt, s.rates?.promptTokensPerS ?? null);
    push(st.ttftP50, s.hist['time_to_first_token_seconds']?.p50 ?? null);
    push(st.e2eP99, s.hist['e2e_request_latency_seconds']?.p99 ?? null);

    const g = s.gauges;
    setNum('v-run', fmtN(g.running));
    setNum('v-wait', fmtN(g.waiting));
    setNum('v-kv', g.kvPct.toFixed(1));
    const kvCard = $('card-kv');
    kvCard.classList.toggle('kv-hot', g.kvPct >= 90);
    kvCard.classList.toggle('kv-warm', g.kvPct >= 70 && g.kvPct < 90);
    setNum('v-gen', fmtN(s.rates?.generationTokensPerS));
    setNum('v-prompt', fmtN(s.rates?.promptTokensPerS));
    setNum('v-ttft', fmtS(s.hist['time_to_first_token_seconds']?.p50));
    setNum('v-e2e', fmtS(s.hist['e2e_request_latency_seconds']?.p99));
    setNum('v-succ', fmtN(s.successTotal));
    $('s-succ').textContent =
      Object.entries(s.successByReason || {}).filter(([, v]) => v > 0).map(([k, v]) => k + ' ' + v).join(' · ') || 'finished requests';
    setNum('v-preem', fmtN(g.preemptions));
    setNum('v-mem', String(Math.round(g.residentMb)));
    setNum('v-model', s.model || '–');
    $('s-engines').textContent = s.engines?.length ? 'engines: ' + s.engines.length : 'engines: –';
    if (s.specDecode) {
      $('card-spec').hidden = false;
      $('v-spec').textContent = (s.specDecode.acceptRate * 100).toFixed(1) + '%';
    }
    document.body.classList.remove('stale');
    $('dot').classList.remove('down');
    $('banner').hidden = true;
    $('updated').textContent = '更新 ' + new Date(s.ts).toLocaleTimeString('zh-CN', { hour12: false });
    $('foot').textContent =
      `实例 ${esc(activeName())} · 抓取 ${s.metricsUrl} · 每 ${intervalMs / 1000}s · 历史 ${MAX} 点（约 ${Math.round(MAX * intervalMs / 60000)} 分钟，仅保存在内存中）`;
    CHARTS.forEach((c) => { draw(c); legend(c); });
  } else {
    for (const k of Object.keys(st)) push(st[k], null); // 断档，图中留空
    document.body.classList.add('stale');
    $('dot').classList.add('down');
    $('banner').hidden = false;
    $('banner').textContent = `实例 “${esc(activeName())}” 抓取失败：${esc(s.error)}`;
  }
}

// ---------- 实例管理 ----------

function renderTabs() {
  dotEls.clear();
  const el = $('tabs');
  el.innerHTML = '';
  for (const t of targets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill' + (t.id === activeId ? ' active' : '');
    b.dataset.id = t.id;
    b.title = t.metricsUrl;
    b.innerHTML = `<i class="st"></i><span>${esc(t.name)}</span><span class="x" title="删除实例">×</span>`;
    b.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('x')) { ev.stopPropagation(); removeTarget(t); return; }
      setActive(t.id);
    });
    el.appendChild(b);
    dotEls.set(t.id, b.querySelector('.st'));
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'pill add';
  add.textContent = '＋ 添加';
  add.addEventListener('click', openModal);
  el.appendChild(add);
}

function setActive(id) {
  activeId = id;
  if (id) localStorage.setItem('vllm.active', id);
  else localStorage.removeItem('vllm.active');
  document.querySelectorAll('.pill[data-id]').forEach((p) => p.classList.toggle('active', p.dataset.id === id));
}

async function syncTargets() {
  const r = await fetch('/api/targets', { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  targets = await r.json();
  if (!targets.some((t) => t.id === activeId)) setActive(targets[0]?.id ?? null);
  renderTabs();
}

async function removeTarget(t) {
  if (!confirm(`删除实例 “${t.name}”？`)) return;
  const r = await fetch('/api/targets/' + encodeURIComponent(t.id), { method: 'DELETE' });
  if (!r.ok) { alert('删除失败：HTTP ' + r.status); return; }
  targets = targets.filter((x) => x.id !== t.id);
  store.delete(t.id);
  if (activeId === t.id) setActive(targets[0]?.id ?? null);
  renderTabs();
}

// 添加实例弹窗
function openModal() {
  $('f-err').hidden = true;
  $('f-res').hidden = true;
  $('modal').hidden = false;
  $('f-name').focus();
}
function closeModal() { $('modal').hidden = true; }
$('f-cancel').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
$('f-base').addEventListener('input', () => {
  const v = $('f-base').value.trim();
  try { $('f-hint').textContent = 'metrics 端点将自动取为：' + new URL(v).origin + '/metrics'; }
  catch { $('f-hint').textContent = 'metrics 端点将自动取为 baseURL 域名根下的 /metrics'; }
});
$('f-test').addEventListener('click', async () => {
  const baseURL = $('f-base').value.trim();
  const apiKey = $('f-key').value.trim();
  const res = $('f-res');
  let parsed;
  try { parsed = new URL(baseURL); }
  catch { res.className = 'mres err'; res.hidden = false; res.textContent = 'Base URL 无效，无法测试'; return; }
  res.hidden = false;
  res.className = 'mres busy';
  res.textContent = '正在测试 ' + parsed.origin + '/metrics …';
  try {
    const r = await fetch('/api/targets/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL, apiKey }),
    });
    const out = await r.json();
    if (out.ok) {
      res.className = 'mres ok';
      res.textContent = '连接成功' + (out.model ? '，模型 ' + out.model : '') + (out.hasVllm ? '' : '，但该端点没有 vllm:* 指标（可能不是 vLLM 服务）');
    } else {
      res.className = 'mres err';
      res.textContent = '连接失败：' + (out.error || '未知错误');
    }
  } catch (e) {
    res.className = 'mres err';
    res.textContent = '无法连接监控服务：' + (e.message || e);
  }
});
$('f-add').addEventListener('click', async () => {
  const name = $('f-name').value.trim();
  const baseURL = $('f-base').value.trim();
  const apiKey = $('f-key').value.trim();
  const err = $('f-err');
  err.hidden = true;
  let parsed;
  try { parsed = new URL(baseURL); }
  catch { err.textContent = '请输入有效的 Base URL（http/https）'; err.hidden = false; return; }
  try {
    const r = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, baseURL, apiKey }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = out.error || '添加失败（HTTP ' + r.status + '）'; err.hidden = false; return; }
    await syncTargets();
    setActive(out.id);
    $('f-name').value = '';
    $('f-base').value = '';
    $('f-key').value = '';
    $('f-hint').textContent = 'metrics 端点将自动取为 baseURL 域名根下的 /metrics';
    closeModal();
  } catch (e) {
    err.textContent = '无法连接监控服务：' + (e.message || e);
    err.hidden = false;
  }
});

// ---------- 轮询 ----------

async function tick() {
  let results = [];
  try {
    results = await Promise.all(targets.map(async (t) => {
      try {
        const r = await fetch('/api/snapshot/' + encodeURIComponent(t.id), { cache: 'no-store' });
        if (r.status === 404) { syncTargets().catch(() => {}); return { id: t.id, snap: null }; }
        return { id: t.id, snap: await r.json() };
      } catch { return { id: t.id, snap: null }; }
    }));
  } catch (e) {
    document.body.classList.add('stale');
    $('dot').classList.add('down');
    $('banner').hidden = false;
    $('banner').textContent = '无法连接监控服务：' + (e.message || e);
  }
  for (const { id, snap } of results) {
    const dot = dotEls.get(id);
    if (dot) dot.classList.toggle('down', !(snap && snap.up));
  }
  const active = results.find((r) => r.id === activeId);
  if (active?.snap) render(active.snap);
  setTimeout(tick, intervalMs);
}

// 刷新间隔：本地选择 + 同步给服务端（服务端抓取间隔随之改变，减少远端负载）
const intervalSel = $('interval');
intervalSel.value = String(intervalMs);
intervalSel.addEventListener('change', () => {
  intervalMs = Number(intervalSel.value);
  localStorage.setItem('vllm.interval', intervalMs);
  fetch('/api/interval', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ms: intervalMs }),
  }).catch(() => {});
});

window.addEventListener('resize', () => CHARTS.forEach(draw));

(async function init() {
  // 本地没选过间隔时，采用服务端当前的抓取间隔，保持两边一致
  if (!localStorage.getItem('vllm.interval')) {
    try {
      const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
      if (INTERVALS.includes(h.scrapeMs)) {
        intervalMs = h.scrapeMs;
        intervalSel.value = String(intervalMs);
      }
    } catch {}
  }
  try { await syncTargets(); } catch {}
  if (!activeId && targets.length) setActive(targets[0].id);
  tick();
})();
})();
