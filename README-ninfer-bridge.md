# nInfer → Prometheus /metrics 桥（ninfer-bridge）

nInfer（capy-flash，`ninfer-serve`）只暴露 OpenAI 兼容 API 和 `/health`，**没有 /metrics 端点**，
所以本仓库的 vLLM 监控面板（GitHub Pages 单文件版 / Node 服务版）抓不到推理速度。
`ninfer-bridge.mjs` 在本机旁路解决：解析 nInfer 日志，以 **vLLM 兼容的指标命名**（`vllm:*`）
输出 Prometheus 文本，挂在独立端口 **50218** 上。面板代码零改动。

## 入口布局（推荐：本地代理，Cloudflare/面板零改动）

`ninfer-proxy.mjs` 把桥"藏"在推理端口后面：**50217 = 代理**，
`/metrics` → 桥（50218），其余 → nInfer（50219）。
这样 Cloudflare tunnel、监控面板、所有客户端的 URL **一个字都不用改**：

    隧道/面板 → https://<原域名>/v1        → 50217 代理 → nInfer 50219
    隧道/面板 → https://<原域名>/metrics   → 50217 代理 → 桥   50218

代理零依赖、流式透传（SSE/大 body 不缓冲）、Authorization 原样透传、
上游不可达时返回 502 JSON。测试：`node --test tests/proxy.test.mjs`。

迁移（一次性，需短暂停 nInfer）：

    bash /home/george/capy-flash/switch-to-proxy.sh

`serve-27b.sh` 已改为：先拉起代理（50217 空闲时），再以 50219 启动 nInfer；
之后每次登录/重启都会自动按此布局恢复。

## 直接连桥（无代理时）

在面板里新增（或修改）实例，baseURL 指向桥（API Key 不变）：

    http://<推理机IP>:50218/v1        # 面板会自动取 <origin>/metrics

面板行为不变：TTFT / E2E 直方图、decode/prefill 速度、running/waiting、
完成原因分布、spec decode（MTP 接受率）、缓存命中率、内存占用等照常显示。

## 日志来源

| 方式 | 配置 | 说明 |
| --- | --- | --- |
| systemd journal（默认） | `JOURNAL_TAG=runvllm.sh.desktop` | GNOME 自启动 `runvllm.sh.desktop` 拉起的 `ninfer-serve` 日志进 journal，identifier 就是 .desktop 文件名。启动时回填最近 2000 行，随后实时跟随 |
| 文件 tail | `LOG_FILE=/path/to/serve.log` | 500ms 轮询，支持日志截断/轮转；设置了 LOG_FILE 时优先于 journal |

`run-bridge.sh` 会自动选择：若 `/home/george/capy-flash/serve.log` 存在且 5 分钟内更新过，
就 tail 这个文件，否则回退 journal（可用 `NINFER_LOG_FILE` 覆盖候选路径）。
**注意**：nInfer 手动启动并把 stdout 重定向到 `serve.log` 时，journal 里可能只有旧进程；
桥必须跟 serve.log，否则指标会停在过去。

窗口时长从日志行的 `throughput | 5.0s |` 读取，因此把 nInfer 的统计间隔改成 1s
不需要改桥：

    ./serve-27b.sh ... --log-stats-interval-ms 1000   # 默认 5000；0 关闭

`serve-27b.sh` 已默认带上 `--log-stats-interval-ms 1000`，需重启 nInfer 生效。

## 指标与 vLLM 语义对照

| 指标 | 来源 | 说明 |
| --- | --- | --- |
| `vllm:num_requests_running` | 窗口行 `running N` | 窗口行新鲜时以日志为准；日志停了才退回在途请求数 |
| `vllm:num_requests_waiting` | 窗口行 `waiting N`，缺失时用 在途 − running | 窗口行过期时退回估算 |
| `vllm:prompt_tokens_total` | 窗口行 prefill token 数 + 每请求 cache 部分 | vLLM 语义（含缓存），用于面板缓存命中率 |
| `vllm:generation_tokens_total` | 窗口行 decode token 数 | 按该行实际窗口时长匀速放行（5s 或 1s），任意轮询频率下 delta/dt 平滑 |
| `vllm:prompt_tokens_cached_total` | 每请求 `cache N` | |
| `vllm:time_to_first_token_seconds` 等 6 个直方图 | 每请求 done 行 | 分桶边界与 vLLM 0.32 完全一致（`vllm/v1/metrics/buckets.py`） |
| `vllm:request_success_total{finished_reason=...}` | done / failed / cancelled 行 | `stop token→stop`、`tool calls→tool_calls`、`output limit→length`、`cancelled→abort`、生成失败→error |
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
