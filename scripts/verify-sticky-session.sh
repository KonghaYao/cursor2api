#!/usr/bin/env bash
# Sticky session removed — use canonical fingerprint verification.
set -euo pipefail
echo "sticky session was removed; running verify-fingerprint-session.sh instead"
exec "$(cd "$(dirname "$0")" && pwd)/verify-fingerprint-session.sh"
