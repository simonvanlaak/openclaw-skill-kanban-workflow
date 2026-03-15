import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SessionMap } from '../automation/session_dispatcher.js';
import type { WorkflowLoopDerivedState } from './workflow_loop_derived_state.js';
import { deriveWorkflowLoopState } from './workflow_loop_derived_state.js';
import type { WorkflowLoopSelectionOutput } from './workflow_loop_ports.js';

export type RocketChatStatusUpdate = {
  outcome: 'updated' | 'skipped_disabled' | 'skipped_dry_run' | 'skipped_unchanged' | 'error';
  desiredMessage?: string;
  status?: string;
  detail?: string;
};

function cleanOneLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

type OpenclawConfig = {
  channels?: {
    rocketchat?: {
      baseUrl?: string;
      userId?: string;
      authToken?: string;
      authTokenFile?: string;
      accounts?: Record<string, { baseUrl?: string; userId?: string; authToken?: string; authTokenFile?: string }>;
    };
  };
};

function defaultOpenclawConfigPath(): string {
  // OpenClaw standard location (see `openclaw config file`).
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

async function loadOpenclawConfig(): Promise<OpenclawConfig | null> {
  const cfgPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || defaultOpenclawConfigPath();
  const raw = await fs.readFile(cfgPath, 'utf8').catch(() => '');
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as OpenclawConfig;
  } catch {
    return null;
  }
}

async function resolveRocketChatCredentials(): Promise<{ baseUrl: string; userId: string; authToken: string } | null> {
  // IMPORTANT: `openclaw config get channels.rocketchat.authToken` returns a redacted value.
  // For status updates we need the real token, so we read the local config file.
  const cfg = await loadOpenclawConfig();
  const rc = cfg?.channels?.rocketchat;
  if (!rc) return null;

  const baseUrl = cleanOneLine(rc.baseUrl ?? '');
  const userId = cleanOneLine(rc.userId ?? '');

  let authToken = cleanOneLine(rc.authToken ?? '');
  if (!authToken) {
    const authTokenFile = cleanOneLine(rc.authTokenFile ?? '');
    if (authTokenFile) {
      authToken = cleanOneLine(await fs.readFile(authTokenFile, 'utf8').catch(() => ''));
    }
  }

  if (!baseUrl || !userId || !authToken) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), userId, authToken };
}

function extractDisplayIdFromSessionLabel(label: string): string | null {
  const clean = cleanOneLine(label);
  if (!clean) return null;
  const first = clean.split(' ')[0]?.trim();
  if (!first) return null;
  return first;
}

function extractIssueKey(raw: string | undefined): string | null {
  const clean = cleanOneLine(raw ?? '');
  if (!clean) return null;
  const match = clean.match(/\b([a-z][a-z0-9]+-\d+)\b/i);
  if (!match?.[1]) return null;
  return match[1].toUpperCase();
}

function desiredMessageFromLoop(params: {
  activeTicketId: string | null;
  activeTitle?: string;
  activeIdentifier?: string;
  tickKind?: string;
  reasonCode?: string;
  sessionLabel?: string;
  sessionId?: string;
}): string {
  if (params.tickKind === 'no_work') {
    // Make idle status human-friendly, avoid technical reason codes.
    if (params.reasonCode) {
      // Common reasons in KWF are internal (e.g. no_backlog_assigned), so translate.
      return 'done with all tickets, waiting for new assignment';
    }
    return 'waiting for new assignment';
  }

  if (!params.activeTicketId) return 'waiting for new assignment';

  const displayIdFromLabel = extractDisplayIdFromSessionLabel(params.sessionLabel ?? '');
  const identifier = cleanOneLine(params.activeIdentifier ?? '');
  const displayId =
    extractIssueKey(identifier) ??
    (identifier || null) ??
    extractIssueKey(displayIdFromLabel ?? undefined) ??
    extractIssueKey(params.sessionId) ??
    extractIssueKey(params.activeTicketId);
  const title = cleanOneLine(params.activeTitle ?? '');
  const raw = displayId
    ? (title ? `working on ${displayId}: ${title}` : `working on ${displayId}`)
    : (title ? `working on ${title}` : 'working on assigned ticket');

  // Keep it short so Rocket.Chat status UI stays readable.
  return raw.length > 96 ? `${raw.slice(0, 93)}...` : raw;
}

async function setRocketChatStatus(params: { baseUrl: string; userId: string; authToken: string; status: string; message: string }): Promise<void> {
  const res = await fetch(`${params.baseUrl}/api/v1/users.setStatus`, {
    method: 'POST',
    headers: {
      'X-User-Id': params.userId,
      'X-Auth-Token': params.authToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: params.status, message: params.message }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Rocket.Chat users.setStatus failed: http=${res.status} body=${text.slice(0, 200)}`);
  }
}

export async function maybeUpdateRocketChatStatusFromWorkflowLoop(params:
  | {
      derivedState: WorkflowLoopDerivedState;
      previousMap: SessionMap;
      map: SessionMap;
      dryRun: boolean;
    }
  | {
      output: WorkflowLoopSelectionOutput;
      previousMap: SessionMap;
      map: SessionMap;
      dryRun: boolean;
    }
): Promise<RocketChatStatusUpdate | null> {
  const enabledRaw = cleanOneLine(process.env.KWF_ROCKETCHAT_STATUS_ENABLED ?? '1');
  const enabled = !['0', 'false', 'no', 'off'].includes(enabledRaw.toLowerCase());
  if (!enabled) return { outcome: 'skipped_disabled', detail: 'KWF_ROCKETCHAT_STATUS_ENABLED=false' };

  const derivedState = 'derivedState' in params
    ? params.derivedState
    : deriveWorkflowLoopState({ output: params.output, map: params.map });

  const desiredMessage = desiredMessageFromLoop({
    activeTicketId: derivedState.activeTicketId,
    activeTitle: derivedState.activeTitle,
    activeIdentifier: derivedState.activeIdentifier,
    tickKind: derivedState.tickKind,
    reasonCode: derivedState.reasonCode,
    sessionLabel: derivedState.activeSessionLabel,
    sessionId: derivedState.activeSessionId,
  });

  const prev = (params.previousMap as any)?.rocketChatStatus?.lastMessage;
  if (typeof prev === 'string' && cleanOneLine(prev) === desiredMessage) {
    return { outcome: 'skipped_unchanged', desiredMessage };
  }

  if (params.dryRun) {
    return { outcome: 'skipped_dry_run', desiredMessage };
  }

  const creds = await resolveRocketChatCredentials();
  if (!creds) {
    return { outcome: 'error', desiredMessage, detail: 'missing_rocketchat_credentials_in_openclaw_config' };
  }

  try {
    await setRocketChatStatus({
      ...creds,
      status: 'online',
      message: desiredMessage,
    });

    (params.map as any).rocketChatStatus = {
      lastMessage: desiredMessage,
      lastUpdatedAt: new Date().toISOString(),
    };

    return { outcome: 'updated', desiredMessage, status: 'online' };
  } catch (err: any) {
    (params.map as any).rocketChatStatus = {
      lastMessage: desiredMessage,
      lastUpdatedAt: new Date().toISOString(),
      lastError: err?.message ?? String(err),
    };

    return { outcome: 'error', desiredMessage, detail: err?.message ?? String(err) };
  }
}
