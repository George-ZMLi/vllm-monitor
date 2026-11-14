#!/usr/bin/env node
/**
 * ninfer-proxy：50217 入口反向代理（Cloudflare tunnel 的落点保持不变）
 *
 *   /metrics  → 127.0.0.1:50218   （ninfer-bridge，vLLM 兼容指标）
 *   *         → 127.0.0.1:50219   （nInfer 本体，OpenAI 兼容 API）
 *
 * 这样隧道与监控面板都零改动：面板取 <origin>/metrics 落到桥，/v1/* 落到 nInfer。
 * 零依赖；**流式透传**（SSE / 大 body 不缓冲、不拼装），Authorization 原样透传
 * （桥和 nInfer 用同一把 key）。任一上游不可达时返回 502 JSON。
 *
 * 环境变量：FRONT_PORT(50217) HOST(0.0.0.0) NINFER_UPSTREAM(127.0.0.1:50219)
 *           BRIDGE_UPSTREAM(127.0.0.1:50218)
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function parseUpstream(spec) {
  const m = String(spec).match(/^(\S+):(\d+)$/);
  if (!m) throw new Error('bad upstream spec: ' + spec);
  return { host: m[1], port: Number(m[2]) };
}

export function startProxy({ frontPort, host, ninferUpstream, bridgeUpstream } = {}) {
  const FRONT = Number(frontPort != null ? frontPort : (process.env.FRONT_PORT || 50217));
  const HOST = host != null ? host : (process.env.HOST || '0.0.0.0');
  const NINFER = parseUpstream(ninferUpstream != null ? ninferUpstream : (process.env.NINFER_UPSTREAM || '127.0.0.1:50219'));
  const BRIDGE = parseUpstream(bridgeUpstream != null ? bridgeUpstream : (process.env.BRIDGE_UPSTREAM || '127.0.0.1:50218'));

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://localhost');
    const target = u.pathname === '/metrics' ? BRIDGE : NINFER;
    const up = http.request(
      { host: target.host, port: target.port, method: req.method, path: req.url, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res); // 逐块透传：SSE 不缓冲
      },
    );
    up.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      }
      res.end(JSON.stringify({ error: { message: 'upstream ' + (u.pathname === '/metrics' ? 'bridge' : 'ninfer') + ' unreachable (' + (e.code || e.message) + ')', type: 'upstream_error' } }));
    });
    res.on('close', () => { try { up.destroy(); } catch {} }); // 客户端断开 → 断开上游
    req.on('error', () => { try { up.destroy(); } catch {} });
    req.pipe(up);
  });
  server.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(FRONT, HOST, () => {
      console.log('[ninfer-proxy] ' + HOST + ':' + FRONT + '  /metrics → ' + BRIDGE.host + ':' + BRIDGE.port
        + '  * → ' + NINFER.host + ':' + NINFER.port);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startProxy().catch((e) => { console.error('[ninfer-proxy] fatal:', e); process.exit(1); });
}
