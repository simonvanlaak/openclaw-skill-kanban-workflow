#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="/var/log/openclaw"
LOG_FILE="$LOG_DIR/kanban-workflow-plane-dispatch.log"
SKILL_DIR="/root/.openclaw/workspace/skills/kanban-workflow"

mkdir -p "$LOG_DIR"

# Keep runtime env consistent with other KWF system jobs.
# shellcheck source=/root/.openclaw/workspace/scripts/lib/op_env_cache.sh
source /root/.openclaw/workspace/scripts/lib/op_env_cache.sh
source /root/.openclaw/workspace/scripts/plane_env.sh

# Optional, safe anti-throttle defaults.
: "${KWF_CODEX_DAY_USAGE_BLOCK_PERCENT:=95}"
: "${KWF_CODEX_5H_USAGE_BLOCK_PERCENT:=99}"
: "${KWF_WORKER_BACKGROUND_DELEGATION:=false}"

{
  echo "[$(date -u +%FT%TZ)] START dispatcher-cron.sh"

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
      echo "[dispatcher-cron] usage guard skipped run: $usage_decision"
      echo "[$(date -u +%FT%TZ)] END dispatcher-cron.sh (skipped)"
      exit 0
    fi
  fi

  cd "$SKILL_DIR"
  npm run -s kanban-workflow -- cron-dispatch --agent kanban-workflow-worker
  echo "[$(date -u +%FT%TZ)] END dispatcher-cron.sh"
} >> "$LOG_FILE" 2>&1
