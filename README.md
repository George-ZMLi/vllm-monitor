# vLLM 监控面板

零依赖的 vLLM metrics 实时监控面板：多实例、TTFT/ITL/延迟直方图、KV Cache 使用率、抢占、速率、投机解码接受率等。全部端点信息仅占位示例，请替换为你自己的 vLLM 服务地址（如 `https://your-vllm.example.com/v1`）。

## 单文件版（推荐）

`index.html` 是唯一产物：无构建、无依赖、无外部请求，双击即可在浏览器打开。

- **添加实例**：打开页面后添加实例 — `名称` + `baseURL`（如 `https://your-vllm.example.com/v1`），可选 `metricsPath`（默认 `/metrics`，如果你的端点在 `/vllm/metrics` 等路径就填它）和 `apiKey`。
- **关于 API Key**：vLLM 的 `--api-key` 只保护 OpenAI 兼容的 API 路由（`/v1/*`），通常 `/metrics` 端点本身**不需要 key**；只有当你的网关对 metrics 也做了鉴权时才需要填 key（以 Bearer 头发送）。
- **手机端**：把 `index.html` 通过微信（或任意方式）发给自己，点开即可用 — 数据只存在浏览器本地 localStorage，不上传任何服务器；页面切到后台/隐藏时自动停止轮询，省流量省电。

## server 版（旧）

如果你更希望通过 Node 服务托管抓取（服务端轮询 + 浏览器看面板）：

```bash
node server.mjs
```

- 环境变量：`PORT`（面板端口，默认 8899）、`SCRAPE_MS`（抓取间隔毫秒，默认 500；界面也可切换 500/1000/2000）。
- 实例列表持久化在同目录 `config.json`，从 `config.json.example` 复制并填入你自己的端点（`baseURL` 如 `https://your-vllm.example.com/v1`，可选 `apiKey`）：

```bash
cp config.json.example config.json
```

- **真实 `config.json` 不进 git**（已 gitignore）— 只提交示例文件。
- 也可不预置配置，直接启动后在界面上添加实例，服务会自动写入 `config.json`。

## 测试

全部测试零依赖，直接 `node` 运行：

```bash
node tests/mock-server.mjs   # mock vLLM metrics，监听 127.0.0.1:8931（MOCK_PORT 可改端口）
node tests/parser.test.mjs
node tests/snapshot.test.mjs
node tests/instance.test.mjs
node tests/poller.test.mjs
```

mock 端点表（用于验证单文件版各输入场景）：

| URL | 行为 |
|---|---|
| `http://127.0.0.1:8931/metrics` | 200，mock vLLM 指标 |
| `http://127.0.0.1:8931/vllm/metrics` | 200（自定义 metricsPath 场景） |
| `http://127.0.0.1:8931/nope/metrics` | 404 |
| `http://127.0.0.1:8931/authz/metrics` | 需 `Authorization: Bearer mock-key`，否则 401 |

## 发布

```bash
git remote add origin <你的 GitHub 仓库地址>
git push -u origin main
git push -u origin feat/static-single-file
```
