# nInfer → Prometheus /metrics 桥（ninfer-bridge）

nInfer（capy-flash，`ninfer-serve`）只暴露 OpenAI 兼容 API 和 `/health`，**没有 /metrics 端点**，
所以本仓库的 vLLM 监控面板（GitHub Pages 单文件版 / Node 服务版）抓不到推理速度。
`ninfer-bridge.mjs` 在本机旁路解决：解析 nInfer 日志，以 **vLLM 兼容的指标命名**（`vllm:*`）
输出 Prometheus 文本，挂在独立端口 **50218** 上。面板代码零改动。

## 使用

在面板里新增（或修改）实例，baseURL 指向桥（API Key 不变）：

    http://<推理机IP>:50218/v1        # 面板会自动取 <origin>/metrics

面板行为不变：TTFT / E2E 直方图、decode/prefill 速度、running/waiting、
完成原因分布、spec decode（MTP 接受率）、缓存命中率、内存占用等照常显示。

## 日志来源

| 方式 | 配置 | 说明 |
| --- | --- | --- |
| systemd journal（默认） | `JOURNAL_TAG=runvllm.sh.desktop` | GNOME 自启动 `runvllm.sh.desktop` 拉起的 `ninfer-serve` 日志进 journal，identifier 就是 .desktop 文件名。启动时回填最近 2000 行，随后实时跟随 |
| 文件 tail | `LOG_FILE=/path/to/serve.log` | 500ms 轮询，支持日志截断/轮转；设置了 LOG_FILE 时优先于 journal |

换启动器导致 journal tag 变化时，设 `JOURNAL_TAG` 即可。

## 指标与 vLLM 语义对照

| 指标 | 来源 | 说明 |
| --- | --- | --- |
| `vllm:num_requests_running` | 窗口行 `running N` + 在途请求数 | 服务器探明离线或无在途请求时为 0 |
| `vllm:num_requests_waiting` | 在途 − running | 近似值（nInfer 不单独打印队列长度） |
| `vllm:prompt_tokens_total` | 窗口行 prefill token 数 + 每请求 cache 部分 | vLLM 语义（含缓存），用于面板缓存命中率 |
| `vllm:generation_tokens_total` | 窗口行 decode token 数 | 按窗口速率匀速放行，任意轮询频率下 delta/dt 平滑 |
| `vllm:prompt_tokens_cached_total` | 每请求 `cache N` | |
| `vllm:time_to_first_token_seconds` 等 6 个直方图 | 每请求 done 行 | 分桶边界与 vLLM 0.32 完全一致（`vllm/v1/metrics/buckets.py`） |
| `vllm:request_success_total{finished_reason=...}` | done 行 | `stop token→stop`、`tool calls→tool_calls`、`output limit→length`、`cancelled→abort` |
| `vllm:spec_decode_num_*_tokens_total` | `mtp accepted A/D` | A=接受，D=提出 |
| `process_resident_memory_bytes` | `/proc/<pid>/status` | 扫描 `ninfer-serve` 进程 |
| `vllm:kv_cache_usage_perc` | — | **nInfer 日志不输出 KV 占用，面板该面板显示 0**（已知限制） |

额外指标（页面未用，便于排障）：`ninfer_up`（/health 存活）、`ninfer_requests_in_flight`、
`ninfer_batch_size`、`ninfer_host_busy_percent`、`ninfer_last_log_age_seconds`、`ninfer_bridge_uptime_seconds`。

## 运行

    ./run-bridge.sh                  # 前台（调试）
    nohup ./run-bridge.sh >/tmp/ninfer-bridge.log 2>&1 &

持久化：`~/.config/autostart/ninfer-bridge.desktop`（与 `runvllm.sh.desktop` 同一模式，
登录自启，日志进 journal，identifier `ninfer-bridge.desktop`）：

    journalctl -t ninfer-bridge.desktop --no-pager -n 20

可调环境变量：`PORT`（50218）、`HOST`（0.0.0.0）、`NINFER_URL`（http://127.0.0.1:50217）、
`MODEL_NAME`（model）、`API_KEY` / `API_KEY_FILE`（默认读 `/home/george/Project/vllm/api-key.txt` 第一行）、
`ALLOWED_ORIGINS`（默认 `https://george-zmli.github.io`，localhost 永远放行）。
设置 API key 后 `/metrics` 需要 `Authorization: Bearer <key>`（与 nInfer 同一把 key）。

## 测试

    node --test tests/bridge.test.mjs

覆盖：数值/时长解析、原因映射、窗口行折算（严格单调回归测试）、直方图分桶、
Prometheus 文本（用页面同款解析器还原）、CORS 预检与鉴权。
