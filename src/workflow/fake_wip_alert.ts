import { execa } from 'execa';

export type FakeWipAlert = {
  sent: boolean;
  message: string;
  detail?: string;
};

function envEnabled(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

export async function maybeSendFakeWipAlert(params: {
  ticketId: string;
  sessionId: string;
  reason: string;
}): Promise<FakeWipAlert> {
  const message = `KWF repaired stale active state for ticket ${params.ticketId} (${params.sessionId}): ${params.reason}`;
  if (!envEnabled('KWF_FAKE_WIP_ALERT_ENABLED', false)) {
    return { sent: false, message, detail: 'disabled_by_default' };
  }

  const channel = String(process.env.KWF_FAKE_WIP_ALERT_CHANNEL ?? 'rocketchat').trim() || 'rocketchat';
  const target = String(process.env.KWF_FAKE_WIP_ALERT_TARGET ?? '@simon.vanlaak').trim();
  if (!target) {
    return { sent: false, message, detail: 'missing_target' };
  }

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
    return { sent: true, message };
  } catch (err) {
    return { sent: false, message, detail: err instanceof Error ? err.message : String(err) };
  }
}
