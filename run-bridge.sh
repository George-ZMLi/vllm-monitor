#!/usr/bin/env bash
# nInfer (capy-flash) → Prometheus /metrics 桥的启动脚本（供手动运行或自启动 .desktop 调用）
#
# 日志源：
#   - 当前服务器由 ~/.config/autostart/runvllm.sh.desktop 拉起（GNOME 自启动），
#     日志进 systemd journal，identifier = runvllm.sh.desktop → 默认直接可读。
#   - 若你改用 nohup/文件方式跑 ninfer-serve，设 LOG_FILE 指向那个日志文件即可。
set -euo pipefail
cd "$(dirname "$0")"
export LOG_FILE="${LOG_FILE:-}"
export JOURNAL_TAG="${JOURNAL_TAG:-runvllm.sh.desktop}"
export PORT="${PORT:-50218}"
export HOST="${HOST:-0.0.0.0}"
export NINFER_URL="${NINFER_URL:-http://127.0.0.1:50217}"
export MODEL_NAME="${MODEL_NAME:-model}"
export API_KEY_FILE="${API_KEY_FILE:-/home/george/Project/vllm/api-key.txt}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://george-zmli.github.io}"
exec node ninfer-bridge.mjs
