#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="/var/log/openclaw"
LOG_FILE="$LOG_DIR/kanban-workflow-plane-workflow-loop.log"
SKILL_DIR="/root/.openclaw/workspace/skills/kanban-workflow"

mkdir -p "$LOG_DIR"

# Keep runtime env consistent with other KWF system jobs.
# shellcheck source=/root/.openclaw/workspace/scripts/lib/op_env_cache.sh
source /root/.openclaw/workspace/scripts/lib/op_env_cache.sh
source /root/.openclaw/workspace/scripts/plane_env.sh

# Optional, safe anti-throttle defaults.
: "${KWF_CODEX_DAY_USAGE_BLOCK_PERCENT:=95}"
: "${KWF_CODEX_5H_USAGE_BLOCK_PERCENT:=99}"
: "${KWF_WORKER_BACKGROUND_DELEGATION:=true}"
export KWF_WORKER_BACKGROUND_DELEGATION

# Disable noisy "no actionable ticket" alerts by default.
# If you ever want them back, set KWF_NO_WORK_ALERT_TARGET to a Rocket.Chat username (e.g. "@simon.vanlaak").
: "${KWF_NO_WORK_ALERT_TARGET:=}"

{
  echo "[$(date -u +%FT%TZ)] START workflow-loop-cron.sh"

  # If Codex daily usage is already at threshold, skip this tick to avoid churn during quota pressure.
  usage_json="$(openclaw status --json --usage 2>/tmp/kanban-workflow-usage.err || true)"
  if [ -n "$usage_json" ]; then
    usage_decision="$(python3 - <<'PY'
import json
import os
import sys

try:
    payload = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)

providers = payload.get('usage', {}).get('providers', []) or []
codex = None
for provider in providers:
    provider_name = provider.get('provider')
    display_name = provider.get('displayName')
    if provider_name == 'openai-codex' or display_name == 'Codex' or display_name == 'openai-codex':
        codex = provider
        break

if not isinstance(codex, dict):
    sys.exit(0)

windows = codex.get('windows') or []
by_label = {str((w or {}).get('label', '')).lower(): w for w in windows if isinstance(w, dict)}

day = by_label.get('day') or by_label.get('7d') or by_label.get('daily')
five_h = by_label.get('5h') or by_label.get('1h') or by_label.get('hour')

try:
    day_used = float(day.get('usedPercent', float('nan')))
except Exception:
    day_used = float('nan')

try:
    fiveh_used = float(five_h.get('usedPercent', float('nan')))
except Exception:
    fiveh_used = float('nan')

day_threshold = float(os.environ.get('KWF_CODEX_DAY_USAGE_BLOCK_PERCENT', '95'))
fiveh_threshold = float(os.environ.get('KWF_CODEX_5H_USAGE_BLOCK_PERCENT', '99'))

if day_used >= day_threshold or fiveh_used >= fiveh_threshold:
    print(f"BLOCK day={day_used} reset={day.get('resetAt') if isinstance(day, dict) else ''} five_h={fiveh_used}")
else:
    print(f"ALLOW day={day_used} five_h={fiveh_used}")
PY
<<< "$usage_json")"

    if [ -n "$usage_decision" ] && [[ "$usage_decision" == BLOCK* ]]; then
      echo "[workflow-loop-cron] usage guard skipped run: $usage_decision"
      echo "[$(date -u +%FT%TZ)] END workflow-loop-cron.sh (skipped)"
      exit 0
    fi
  fi

  : "${KWF_WORKFLOW_LOOP_TIMEOUT_SEC:=1800}" # 30 min safety net for cron runs

  cd "$SKILL_DIR"
  echo "[workflow-loop-cron] running workflow-loop (timeout=${KWF_WORKFLOW_LOOP_TIMEOUT_SEC}s)"
  timeout "${KWF_WORKFLOW_LOOP_TIMEOUT_SEC}s" npm run -s kanban-workflow -- workflow-loop || {
    rc=$?
    if [ "$rc" -eq 124 ]; then
      echo "[workflow-loop-cron] workflow-loop timed out after ${KWF_WORKFLOW_LOOP_TIMEOUT_SEC}s"
    else
      echo "[workflow-loop-cron] workflow-loop failed (rc=$rc)"
    fi
    echo "[$(date -u +%FT%TZ)] END workflow-loop-cron.sh (failed)"
    exit 1
  }

  echo "[$(date -u +%FT%TZ)] END workflow-loop-cron.sh"
} >> "$LOG_FILE" 2>&1
