import assert from 'node:assert/strict';
import { loadCore, test } from './helpers.mjs';

const FIX = `# HELP t_a_seconds x
# TYPE t_a_seconds histogram
t_a_seconds_bucket{le="0.5"} 10
t_a_seconds_bucket{le="1"} 18
t_a_seconds_bucket{le="+Inf"} 20
t_a_seconds_sum 12.5
t_a_seconds_count 20
vllm:num_requests_running{model_name="m1", engine="0"} 3
vllm:num_requests_running{model_name="m1", engine="1"} 1
vllm:num_requests_waiting{model_name="m1"} 2
vllm:prompt_tokens_total 1000
not_a_number abc`;

const { parseProm, sumSeries, histogram, percentile } = loadCore();
const native = (v) => structuredClone(v); // vm realm 对象转 native realm 供 assert.deepEqual 比对

test('parseProm: 跳过注释/非法行，解析标签', () => {
  const s = parseProm(FIX);
  assert.equal(s['vllm:num_requests_running'].length, 2);
  assert.deepEqual(native(s['vllm:num_requests_running'][0].labels), { model_name: 'm1', engine: '0' });
  assert.equal(s['not_a_number'], undefined);
});
test('sumSeries: 多标签求和 / 缺失返回 null', () => {
  const s = parseProm(FIX);
  assert.equal(sumSeries(s, 'vllm:num_requests_running'), 4);
  assert.equal(sumSeries(s, 'nope'), null);
});
test('histogram + percentile: 桶/计数/均值/插值', () => {
  const s = parseProm(FIX);
  const h = histogram(s, 't_a_seconds');
  assert.deepEqual(native(h.buckets), [[0.5, 10], [1, 18], [Infinity, 20]]);
  assert.equal(h.count, 20);
  assert.equal(h.avg, 0.625);
  assert.equal(percentile(h.buckets, 20, 0.5), 0.5);
  assert.equal(percentile(h.buckets, 20, 0.99), null); // target 落入 +Inf 桶 → null（移植行为）
  assert.equal(percentile([], 0, 0.5), null);
});
