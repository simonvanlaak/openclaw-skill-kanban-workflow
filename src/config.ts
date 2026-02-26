import { z } from 'zod';

export const ClawbanConfigV1Schema = z.object({
  version: z.literal(1),
  adapters: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('github'),
          repo: z.string().min(1),
          project: z
            .object({
              number: z.number().int().positive(),
              owner: z.string().min(1),
            })
            .optional(),
        }),
        z.object({
          kind: z.literal('linear'),
          teamId: z.string().optional(),
          projectId: z.string().optional(),
        }),
        z.object({
          kind: z.literal('plane'),
          workspaceSlug: z.string().min(1),
          projectId: z.string().min(1),
        }),
        z.object({
          kind: z.literal('planka'),
          bin: z.string().optional(),
        }),
      ]),
    )
    .default([]),
});

export type ClawbanConfigV1 = z.infer<typeof ClawbanConfigV1Schema>;

export type ClawbanConfig = ClawbanConfigV1;
export const ClawbanConfigSchema = ClawbanConfigV1Schema;

export type FsLike = {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  writeFile(path: string, content: string, encoding: 'utf-8'): Promise<void>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
};

export async function loadConfigFromFile(opts: {
  fs: FsLike;
  path: string;
}): Promise<ClawbanConfig> {
  const text = await opts.fs.readFile(opts.path, 'utf-8');
  const parsed = JSON.parse(text);
  return ClawbanConfigSchema.parse(parsed);
}

export async function writeConfigToFile(opts: {
  fs: FsLike;
  path: string;
  config: ClawbanConfig;
}): Promise<void> {
  const dir = opts.path.split('/').slice(0, -1).join('/') || '.';
  await opts.fs.mkdir(dir, { recursive: true });
  await opts.fs.writeFile(opts.path, `${JSON.stringify(opts.config, null, 2)}\n`, 'utf-8');
}
