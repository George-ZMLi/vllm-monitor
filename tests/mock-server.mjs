// 零依赖 mock vLLM metrics 服务 — 仅用于本地 file:// 验证（只监听 127.0.0.1）
// 用法：node tests/mock-server.mjs（可用 MOCK_PORT 改端口，默认 8931）
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT) || 8931;
let seq = 0; // 请求计数：让 generation/success 每次递增，速率非 0

function fixture() {
  seq += 1;
  return [
    'vllm:num_requests_running{engine="0",model_name="mock-model"} 3',
    'vllm:num_requests_running{engine="1",model_name="mock-model"} 1',
    'vllm:num_requests_waiting 2',
    'vllm:kv_cache_usage_perc 0.42',
    'vllm:num_preemptions_total 5',
    'vllm:prompt_tokens_total 1000',
    'vllm:prompt_tokens_cached_total 370', // 固定 370/1000 → 基准命中率恒为 37.0%（占位符，不随 seq 增长）
    `vllm:generation_tokens_total ${123 * seq}`,
    `vllm:request_success_total{finished_reason="stop"} ${41 + seq}`,
    'vllm:time_to_first_token_seconds_bucket{le="0.5"} 10',
    'vllm:time_to_first_token_seconds_bucket{le="1.0"} 25',
    'vllm:time_to_first_token_seconds_bucket{le="2.0"} 40',
    'vllm:time_to_first_token_seconds_bucket{le="+Inf"} 50',
    'vllm:time_to_first_token_seconds_count 50',
    'vllm:time_to_first_token_seconds_sum 30.5',
    'process_resident_memory_bytes 2147483648',
  ].join('\n') + '\n';
}

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'text/plain; charset=utf-8',
  };
  if (req.method === 'OPTIONS') { // CORS 预检
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    res.end();
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const isHead = req.method === 'HEAD';
    if (req.url === '/metrics' || req.url === '/vllm/metrics') {
      res.writeHead(200, headers);
      res.end(isHead ? undefined : fixture());
      return;
    }
    if (req.url === '/authz/metrics') {
      if (req.headers['authorization'] !== 'Bearer mock-key') {
        res.writeHead(401, Object.assign({}, headers, { 'WWW-Authenticate': 'Bearer' }));
        res.end(isHead ? undefined : 'unauthorized');
        return;
      }
      res.writeHead(200, headers);
      res.end(isHead ? undefined : fixture());
      return;
    }
    // /nope/metrics 及未知路径
    res.writeHead(404, headers);
    res.end(isHead ? undefined : 'not found');
    return;
  }
  res.writeHead(405, headers);
  res.end('method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock vLLM metrics server listening on http://127.0.0.1:${PORT}`);
});
