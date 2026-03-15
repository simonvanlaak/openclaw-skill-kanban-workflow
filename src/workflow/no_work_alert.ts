import { execa } from 'execa';

import type { SessionMap } from '../automation/session_dispatcher.js';
import type { WorkflowLoopDerivedState } from './workflow_loop_derived_state.js';

export type NoWorkAlertResult = {
  outcome: 'first_hit_sent' | 'first_hit_skipped' | 'repeat_suppressed' | 'send_error';
  channel?: string;
  target?: string;
  message?: string;
  reasonCode?: string;
  detail?: string;
};

export const DEFAULT_NO_WORK_ALERT_CHANNEL = 'rocketchat';
export const DEFAULT_NO_WORK_ALERT_TARGET = '@simon.vanlaak';

function envFlagEnabled(name: string, defaultValue: boolean): boolean {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

function buildNoWorkFirstHitAlertMessage(reasonCode?: string): string {
  const reasonSuffix = reasonCode ? ` (reason: ${reasonCode})` : '';
  return `Kanban workflow-loop first no-work hit: there is no actionable ticket right now${reasonSuffix}. I will stay idle until a new ticket becomes actionable.`;
}

export async function maybeSendNoWorkFirstHitAlert(params: {
  derivedState: WorkflowLoopDerivedState;
  previousMap: SessionMap;
  map: SessionMap;
  dryRun: boolean;
  channel?: string;
  target?: string;
}): Promise<NoWorkAlertResult | null> {
  // Disabled by default to avoid DM spam. Enable explicitly if desired.
  const enabled = envFlagEnabled('KWF_NO_WORK_ALERT_ENABLED', false);
  if (!enabled) return { outcome: 'first_hit_skipped', detail: 'disabled_by_default' };

  if (params.derivedState.tickKind !== 'no_work') return null;

  const hasExistingNoWorkStreak = Boolean(params.previousMap.noWork);
  const alreadyAlertedInStreak = Boolean(params.previousMap.noWork?.firstHitAlertSentAt);
  if (hasExistingNoWorkStreak && alreadyAlertedInStreak) {
    return { outcome: 'repeat_suppressed', reasonCode: params.derivedState.reasonCode };
  }

  if (params.dryRun) {
    return { outcome: 'first_hit_skipped', reasonCode: params.derivedState.reasonCode, detail: 'dry_run' };
  }

  const channel = (params.channel ?? process.env.KWF_NO_WORK_ALERT_CHANNEL ?? DEFAULT_NO_WORK_ALERT_CHANNEL).trim() || DEFAULT_NO_WORK_ALERT_CHANNEL;
  const target = (params.target ?? process.env.KWF_NO_WORK_ALERT_TARGET ?? DEFAULT_NO_WORK_ALERT_TARGET).trim();
  if (!target) {
    return { outcome: 'first_hit_skipped', channel, reasonCode: params.derivedState.reasonCode, detail: 'missing_target' };
  }

  const message = buildNoWorkFirstHitAlertMessage(params.derivedState.reasonCode);

  try {
    await execa('openclaw', [
      'message',
      'send',
      '--channel',
      channel,
      '--target',
      target,
      '--message',
      message,
      '--json',
    ]);

    if (params.map.noWork) {
      params.map.noWork.firstHitAlertSentAt = new Date().toISOString();
      params.map.noWork.firstHitAlertChannel = channel;
      params.map.noWork.firstHitAlertTarget = target;
    }

    return {
      outcome: 'first_hit_sent',
      channel,
      target,
      message,
      reasonCode: params.derivedState.reasonCode,
    };
  } catch (err: any) {
    return {
      outcome: 'send_error',
      channel,
      target,
      message,
      reasonCode: params.derivedState.reasonCode,
      detail: err?.message ?? String(err),
    };
  }
}
