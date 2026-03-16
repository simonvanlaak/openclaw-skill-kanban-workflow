#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="/var/log/openclaw"
LOG_FILE="$LOG_DIR/kanban-workflow-auto-reopen-scan.log"
SKILL_DIR="/root/.openclaw/workspace/skills/kanban-workflow"

mkdir -p "$LOG_DIR"

source /root/.openclaw/workspace/scripts/lib/op_env_cache.sh
source /root/.openclaw/workspace/scripts/plane_env.sh

{
  echo "[$(date -u +%FT%TZ)] START auto-reopen-scan-cron.sh"
  cd "$SKILL_DIR"
  npm run -s kanban-workflow -- auto-reopen-scan
  echo "[$(date -u +%FT%TZ)] END auto-reopen-scan-cron.sh"
} >> "$LOG_FILE" 2>&1
