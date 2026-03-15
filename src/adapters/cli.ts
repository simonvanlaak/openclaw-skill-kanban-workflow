import { execa } from 'execa';

const DEFAULT_CLI_TIMEOUT_MS = Number.parseInt(process.env.KWF_CLI_TIMEOUT_MS ?? '60000', 10);

export class CliError extends Error {
  override name = 'CliError';
}

export class CliRunner {
  private readonly bin: string;

  constructor(bin: string) {
    this.bin = bin;
  }

  async run(args: readonly string[]): Promise<string> {
    try {
      const proc = await execa(this.bin, [...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: Number.isFinite(DEFAULT_CLI_TIMEOUT_MS) && DEFAULT_CLI_TIMEOUT_MS > 0 ? DEFAULT_CLI_TIMEOUT_MS : 60000,
        forceKillAfterTimeout: 5000,
      });
      return proc.stdout;
    } catch (err: any) {
      // execa throws an Error with shape similar to:
      // { code: 'ENOENT', shortMessage: 'spawn <bin> ENOENT', ... }
      if (err?.code === 'ENOENT') {
        throw new CliError(
          [
            `Required binary not found on PATH: ${this.bin}`,
            `Command: ${this.bin} ${args.join(' ')}`,
            `What next: install '${this.bin}' (and any wrapper it depends on) and ensure it is available on PATH; then confirm you're authenticated using that CLI.`,
          ].join('\n'),
        );
      }

      const message = typeof err?.message === 'string' ? err.message : String(err);
      const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
      const timedOut = err?.timedOut === true || err?.signal === 'SIGTERM' || err?.signal === 'SIGKILL';
      const timeoutNote = timedOut
        ? `\nTimeout: command exceeded ${Number.isFinite(DEFAULT_CLI_TIMEOUT_MS) && DEFAULT_CLI_TIMEOUT_MS > 0 ? DEFAULT_CLI_TIMEOUT_MS : 60000}ms`
        : '';
      throw new CliError(
        `${this.bin} command failed: ${this.bin} ${args.join(' ')}\n${message}${timeoutNote}${stderr ? `\n${stderr}` : ''}`.trim(),
      );
    }
  }
}
