#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="/var/log/openclaw"
LOG_FILE="$LOG_DIR/kanban-workflow-startup-repair.log"
SKILL_DIR="/root/.openclaw/workspace/skills/kanban-workflow"

mkdir -p "$LOG_DIR"

source /root/.openclaw/workspace/scripts/lib/op_env_cache.sh
source /root/.openclaw/workspace/scripts/plane_env.sh

{
  echo "[$(date -u +%FT%TZ)] START startup_repair.sh"
  cd "$SKILL_DIR"
  npm run -s kanban-workflow -- reliability-self-check || true
  timeout "${KWF_STARTUP_REPAIR_TIMEOUT_SEC:-900}s" npm run -s kanban-workflow -- reconcile-active-runs
  echo "[$(date -u +%FT%TZ)] END startup_repair.sh"
} >> "$LOG_FILE" 2>&1
