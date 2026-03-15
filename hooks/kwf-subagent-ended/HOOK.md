---
name: kwf-subagent-ended
description: "Trigger kanban-workflow reconciliation when a worker subagent finishes"
metadata:
  {
    "openclaw":
      {
        "emoji": "🪝",
        "events": ["subagent_ended"],
      },
  }
---

# KWF Subagent Ended

Runs KWF reconciliation immediately when a `kanban-workflow-worker` spawned
subagent ends.
