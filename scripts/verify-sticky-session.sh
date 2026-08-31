#!/usr/bin/env bash
# 验证无 conversation_id 时多轮粘性 session（需本机已 npm start）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -f .env ]]; then set -a; # shellcheck disable=SC1091
  source .env; set +a; fi
: "${CURSOR_API_KEY:?set CURSOR_API_KEY or .env}"
BASE="${BASE:-http://127.0.0.1:8789}"
TOKEN="Bearer ${CURSOR_API_KEY}"

curl -sf "$BASE/health" >/dev/null || { echo "gateway not up at $BASE"; exit 1; }

curl -sS -D /tmp/c2api-r1.hdr -o /tmp/c2api-r1.json \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  "$BASE/v1/chat/completions" \
  -d '{"model":"grok-4.6","messages":[{"role":"user","content":"Reply with exactly: ROUND1"}]}'

SID1=$(grep -i '^x-session-id:' /tmp/c2api-r1.hdr | awk '{print $2}' | tr -d '\r')

curl -sS -D /tmp/c2api-r2.hdr -o /tmp/c2api-r2.json \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  "$BASE/v1/chat/completions" \
  -d '{"model":"grok-4.6","messages":[{"role":"user","content":"Reply with exactly: ROUND1"},{"role":"assistant","content":"ROUND1"},{"role":"user","content":"Reply with exactly: ROUND2"}]}'

SID2=$(grep -i '^x-session-id:' /tmp/c2api-r2.hdr | awk '{print $2}' | tr -d '\r')
echo "round1 x-session-id: $SID1"
echo "round2 x-session-id: $SID2"
[[ -n "$SID1" && "$SID1" == "$SID2" ]] && echo "OK: sticky session" || { echo "FAIL"; exit 1; }
