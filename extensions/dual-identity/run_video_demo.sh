#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_PROFILE="${OPENCLAW_PROFILE:-dual-identity}"
OPENCLAW_AGENT="${OPENCLAW_AGENT:-main}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
SESSION_PREFIX="${SESSION_PREFIX:-dual-identity-demo}"
THINKING_MODE="${THINKING_MODE:-off}"

if [[ "${OPENCLAW_PROFILE}" == "default" ]]; then
  PROFILE_HOME="${HOME}/.openclaw"
else
  PROFILE_HOME="${HOME}/.openclaw-${OPENCLAW_PROFILE}"
fi

AUDIT_DIR="${PROFILE_HOME}/plugins/dual-identity"
AUDIT_FILE="${AUDIT_DIR}/audit-$(date +%F).jsonl"
SESSION_ONE="dual-identity-demo-1"
SESSION_TWO="dual-identity-demo-2"
SESSION_ONE="${SESSION_PREFIX}-1"
SESSION_TWO="${SESSION_PREFIX}-2"
DEMO_ONE_MESSAGE="${DEMO_ONE_MESSAGE:-Reply with exactly: ok}"
DEMO_TWO_MESSAGE="${DEMO_TWO_MESSAGE:-Use the sessions_spawn tool exactly once to spawn a subagent that replies with the single word done, then summarize in one sentence that the child run was started.}"

OPENCLAW_CMD=("${OPENCLAW_BIN}" "--profile" "${OPENCLAW_PROFILE}")

mkdir -p "${AUDIT_DIR}"
touch "${AUDIT_FILE}"

before_lines="$(wc -l < "${AUDIT_FILE}" | tr -d ' ')"

echo
echo "=== 1. Confirm dual-identity profile and plugin ==="
echo "Profile: ${OPENCLAW_PROFILE}"
echo "Profile home: ${PROFILE_HOME}"
echo "Audit file: ${AUDIT_FILE}"
"${OPENCLAW_CMD[@]}" plugins list | awk '
  NR <= 12 { print; next }
  /Dual Identity|dual-identity/ { print; capture=4; next }
  capture > 0 { print; capture--; next }
'

echo
echo "=== 2. Demo 1: minimal delegated run ==="
if ! "${OPENCLAW_CMD[@]}" agent --local --agent "${OPENCLAW_AGENT}" --session-id "${SESSION_ONE}" --message "${DEMO_ONE_MESSAGE}" --thinking "${THINKING_MODE}" --json; then
  echo "[dual-identity-demo] Demo 1 exited non-zero; continuing so audit can still be inspected."
fi

echo
echo "=== 3. Demo 2: stronger tool/subagent chain ==="
if ! "${OPENCLAW_CMD[@]}" agent --local --agent "${OPENCLAW_AGENT}" --session-id "${SESSION_TWO}" --message "${DEMO_TWO_MESSAGE}" --thinking "${THINKING_MODE}" --json; then
  echo "[dual-identity-demo] Demo 2 exited non-zero; continuing so audit can still be inspected."
fi

echo
echo "=== 4. New dual-identity audit events ==="
after_start=$((before_lines + 1))
tail -n +"${after_start}" "${AUDIT_FILE}"

echo
echo "Audit file: ${AUDIT_FILE}"
