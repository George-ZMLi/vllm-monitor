#!/usr/bin/env bash
# nInfer (capy-flash) → Prometheus /metrics 桥的启动脚本（供手动运行或自启动 .desktop 调用）
#
# 日志源：
#   - 当前服务器由 ~/.config/autostart/runvllm.sh.desktop 拉起（GNOME 自启动），
#     日志进 systemd journal，identifier = runvllm.sh.desktop → 默认直接可读。
#   - 若你改用 nohup/文件方式跑 ninfer-serve，设 LOG_FILE 指向那个日志文件即可。
set -euo pipefail
cd "$(dirname "$0")"
# 日志源自动选择：nInfer 若把 stdout 重定向到 serve.log，优先 tail 它；
# 文件超过 5 分钟没更新时退回 journal（避免读到已停更的旧进程日志）。
NINFER_LOG_FILE="${NINFER_LOG_FILE:-/home/george/capy-flash/serve.log}"
if [ -z "${LOG_FILE:-}" ] && [ -r "$NINFER_LOG_FILE" ] && [ -n "$(find "$NINFER_LOG_FILE" -mmin -5 2>/dev/null)" ]; then
  export LOG_FILE="$NINFER_LOG_FILE"
fi
export JOURNAL_TAG="${JOURNAL_TAG:-runvllm.sh.desktop}"
export PORT="${PORT:-50218}"
export HOST="${HOST:-0.0.0.0}"
export NINFER_URL="${NINFER_URL:-http://127.0.0.1:50217}"
export MODEL_NAME="${MODEL_NAME:-model}"
export API_KEY_FILE="${API_KEY_FILE:-/home/george/Project/vllm/api-key.txt}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://george-zmli.github.io}"
# 已有一个桥在跑（例如手动启动过，本次是登录自启动）→ 不重复拉起
if curl -s -m 2 -o /dev/null "http://127.0.0.1:${PORT}/health"; then
  echo "ninfer-bridge: port ${PORT} already serving; skipping duplicate start"
  exit 0
fi
exec node ninfer-bridge.mjs
