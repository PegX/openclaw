#!/usr/bin/env bash
set -euo pipefail

AUDIT_DIR="${HOME}/.openclaw/plugins/dual-identity"
AUDIT_FILE="${AUDIT_DIR}/audit-$(date +%F).jsonl"
SESSION_ONE="dual-identity-demo-1"
SESSION_TWO="dual-identity-demo-2"

mkdir -p "${AUDIT_DIR}"
touch "${AUDIT_FILE}"

before_lines="$(wc -l < "${AUDIT_FILE}" | tr -d ' ')"

echo
echo "=== 1. Confirm plugin is loaded ==="
openclaw plugins list | sed -n '1,40p'

echo
echo "=== 2. Demo 1: minimal delegated run ==="
openclaw agent --local --agent main --session-id "${SESSION_ONE}" --message "Reply with exactly: ok" --json

echo
echo "=== 3. Demo 2: stronger tool/subagent chain ==="
openclaw agent --local --agent main --session-id "${SESSION_TWO}" --message "Use the sessions_spawn tool exactly once to spawn a subagent that replies with the single word done, then summarize in one sentence that the child run was started." --json

echo
echo "=== 4. New dual-identity audit events ==="
after_start=$((before_lines + 1))
tail -n +"${after_start}" "${AUDIT_FILE}"

echo
echo "Audit file: ${AUDIT_FILE}"
