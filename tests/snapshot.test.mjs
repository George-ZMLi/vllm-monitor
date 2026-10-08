import assert from 'node:assert/strict';
import { loadCore, test, deepEqual } from './helpers.mjs';

const { parseProm, buildSnapshot, computeRates } = loadCore();

const FIX = `vllm:num_requests_running{model_name="m1", engine="0"} 3
vllm:num_requests_running{model_name="m1", engine="1"} 1
vllm:num_requests_waiting{model_name="m1"} 2
vllm:kv_cache_usage_perc 0.42
vllm:num_preemptions_total 5
vllm:prompt_tokens_total 1000
vllm:generation_tokens_total 2000
vllm:prompt_tokens_cached_total 300
vllm:request_success_total{finished_reason="stop"} 41
vllm:request_success_total{finished_reason="length"} 4
vllm:time_to_first_token_seconds_bucket{le="0.5"} 200
vllm:time_to_first_token_seconds_bucket{le="1"} 600
vllm:time_to_first_token_seconds_bucket{le="2"} 995
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 1000
vllm:time_to_first_token_seconds_sum 1500
vllm:time_to_first_token_seconds_count 1000
process_resident_memory_bytes 2147483648`;

test('buildSnapshot: gauge/成功分布/直方图/模型', () => {
  const s = buildSnapshot(parseProm(FIX));
  assert.equal(s.gauges.running, 4);
  assert.equal(s.gauges.waiting, 2);
  assert.equal(s.gauges.kvPct, 0.42);
  assert.equal(s.gauges.residentMb, 2048);
  assert.ok(deepEqual(s.successByReason, { stop: 41, length: 4 }));
  assert.equal(s.successTotal, 45);
  assert.equal(s.model, 'm1');
  assert.ok(deepEqual(s.engines, ['0', '1']));
  assert.equal(s.specDecode, null);
  const h = s.hist['time_to_first_token_seconds'];
  assert.equal(h.count, 1000);
  assert.equal(h.avg, 1.5);
  assert.equal(h.p50, 0.875);
  assert.ok(Math.abs(h.p99 - 1.9873417721) < 1e-6); // 990/395 插值
  const empty = s.hist['inter_token_latency_seconds'];
  assert.ok(deepEqual(empty, { count: 0, avg: null, p50: null, p99: null }));
});
test('buildSnapshot: 投机解码存在时解析', () => {
  const s = buildSnapshot(parseProm(FIX + `
vllm:spec_decode_num_draft_tokens_total 100
vllm:spec_decode_num_accepted_tokens_total 80`));
  assert.ok(deepEqual(s.specDecode, { drafts: 100, accepted: 80, acceptRate: 0.8 }));
});
test('computeRates: 正常差值 / 计数器回退 null / 单条 null / 同 ts null', () => {
  const r = computeRates([
    { ts: 0, c: { prompt: 100, generation: 1000, success: 10, preemptions: 1 } },
    { ts: 2000, c: { prompt: 130, generation: 500, success: 12, preemptions: 1 } },
  ]);
  assert.equal(r.promptTokensPerS, 15);
  assert.equal(r.generationTokensPerS, null); // 1000 → 500 回退（Review Focus #3）
  assert.equal(r.requestsPerS, 1);
  assert.equal(r.preemptionsPerS, 0);
  assert.equal(computeRates([{ ts: 0, c: {} }]), null);
  assert.equal(computeRates([
    { ts: 5, c: { prompt: 1, generation: 1, success: 1, preemptions: 1 } },
    { ts: 5, c: { prompt: 2, generation: 2, success: 2, preemptions: 2 } },
  ]), null);
});
