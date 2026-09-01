#!/usr/bin/env bash
# 验证默认 fingerprint 下多轮 canon 合并（需本机已 npm start / deno task start）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -f .env ]]; then set -a; # shellcheck disable=SC1091
  source .env; set +a; fi
: "${CURSOR_API_KEY:?set CURSOR_API_KEY or .env}"
BASE="${BASE:-http://127.0.0.1:8789}"
TOKEN="Bearer ${CURSOR_API_KEY}"

curl -sf "$BASE/health" >/dev/null || { echo "gateway not up at $BASE"; exit 1; }

curl -sS -D /tmp/c2api-fp-r1.hdr -o /tmp/c2api-fp-r1.json \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  "$BASE/v1/chat/completions" \
  -d '{"model":"grok-4.6","messages":[{"role":"user","content":"Reply with exactly: FP_ROUND1"}]}'

SID1=$(grep -i '^x-session-id:' /tmp/c2api-fp-r1.hdr | awk '{print $2}' | tr -d '\r' || true)

curl -sS -D /tmp/c2api-fp-r2.hdr -o /tmp/c2api-fp-r2.json \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  "$BASE/v1/chat/completions" \
  -d '{"model":"grok-4.6","messages":[{"role":"user","content":"Reply with exactly: FP_ROUND1"},{"role":"assistant","content":"FP_ROUND1"},{"role":"user","content":"Reply with exactly: FP_ROUND2"}]}'

SID2=$(grep -i '^x-session-id:' /tmp/c2api-fp-r2.hdr | awk '{print $2}' | tr -d '\r' || true)
echo "round1 x-session-id: ${SID1:-<none>}"
echo "round2 x-session-id: ${SID2:-<none>}"
echo "round2 body (truncated): $(head -c 200 /tmp/c2api-fp-r2.json)"
echo "OK: fingerprint session script completed (check gateway logs for canon_len merge=hit)"
