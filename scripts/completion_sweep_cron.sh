#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="/var/log/openclaw"
LOG_FILE="$LOG_DIR/kanban-workflow-completion-sweep.log"
SKILL_DIR="/root/.openclaw/workspace/skills/kanban-workflow"

mkdir -p "$LOG_DIR"

source /root/.openclaw/workspace/scripts/lib/op_env_cache.sh
source /root/.openclaw/workspace/scripts/plane_env.sh

{
  echo "[$(date -u +%FT%TZ)] START completion_sweep_cron.sh"
  cd "$SKILL_DIR"
  timeout "${KWF_COMPLETION_SWEEP_TIMEOUT_SEC:-600}s" npm run -s kanban-workflow -- reconcile-active-runs
  echo "[$(date -u +%FT%TZ)] END completion_sweep_cron.sh"
} >> "$LOG_FILE" 2>&1
