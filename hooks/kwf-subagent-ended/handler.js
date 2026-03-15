import { execFile } from "node:child_process";

function isWorkerChildSessionKey(value) {
  return typeof value === "string" && value.startsWith("agent:kanban-workflow-worker:subagent:");
}

export default async function kwfSubagentEnded(event) {
  const childSessionKey = typeof event?.targetSessionKey === "string" ? event.targetSessionKey.trim() : "";
  if (!isWorkerChildSessionKey(childSessionKey)) {
    return;
  }

  const repoDir = "/root/.openclaw/workspace/skills/kanban-workflow";
  const args = [
    "run",
    "-s",
    "kanban-workflow",
    "--",
    "reconcile-subagent-ended",
    "--child-session-key",
    childSessionKey,
  ];

  await new Promise((resolve) => {
    execFile("npm", args, { cwd: repoDir }, () => resolve(undefined));
  });
}
