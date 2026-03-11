import { z } from 'zod';

const MIN_TEXT_LENGTH = 20;
const MAX_ITEMS_PER_ARRAY = 5;

const nonEmptyText = z.string().trim().min(MIN_TEXT_LENGTH, `must be at least ${MIN_TEXT_LENGTH} characters long`);
const boundedTextArray = z.array(nonEmptyText).max(MAX_ITEMS_PER_ARRAY, `must contain at most ${MAX_ITEMS_PER_ARRAY} items`);

const MIN_LINK_TITLE_LENGTH = 3;

const linkItem = z
  .object({
    title: z.string().trim().min(MIN_LINK_TITLE_LENGTH, `must be at least ${MIN_LINK_TITLE_LENGTH} characters long`),
    url: z.string().trim().url('must be a valid URL').refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://'),
  })
  .strict();

const linksArray = z.array(linkItem).max(MAX_ITEMS_PER_ARRAY, `must contain at most ${MAX_ITEMS_PER_ARRAY} items`);

export const WORKER_RESULT_JSON_SCHEMA_CONTRACT = [
  'WORKER_RESULT_JSON_SCHEMA_CONTRACT',
  '- Output must be a single JSON object (no markdown, no code fences).',
  '- Strict mode: unknown fields are rejected.',
  '- Required fields:',
  '  - decision: "blocked" | "completed" | "uncertain"',
  `  - completed_steps: string[] (min 1, max ${MAX_ITEMS_PER_ARRAY}; each item min ${MIN_TEXT_LENGTH} chars)`,
  `  - clarification_questions: string[] (max ${MAX_ITEMS_PER_ARRAY}; each item min ${MIN_TEXT_LENGTH} chars)`,
  `  - blocker_resolve_requests: string[] (max ${MAX_ITEMS_PER_ARRAY}; each item min ${MIN_TEXT_LENGTH} chars)`,
  '  - solution_summary: string (min 20 chars) when decision="completed"; disallowed otherwise',
  `  - evidence: string[] (max ${MAX_ITEMS_PER_ARRAY}; each item min ${MIN_TEXT_LENGTH} chars)`,
  '- Optional fields:',
  `  - links: { title: string (min ${MIN_LINK_TITLE_LENGTH}), url: string (http/https) }[] (max ${MAX_ITEMS_PER_ARRAY})`,
  '- Decision rules:',
  '  - blocked: blocker_resolve_requests must have at least 1 item; clarification_questions/evidence must be empty; solution_summary disallowed',
  '  - uncertain: clarification_questions must have at least 1 item; blocker_resolve_requests/evidence must be empty; solution_summary disallowed',
  '  - completed: solution_summary required; evidence must have at least 1 item; clarification_questions/blocker_resolve_requests must be empty',
].join('\n');

const WorkerResultSchema = z
  .object({
    decision: z.enum(['blocked', 'completed', 'uncertain']),
    completed_steps: boundedTextArray.min(1, 'must contain at least 1 item'),
    clarification_questions: boundedTextArray,
    blocker_resolve_requests: boundedTextArray,
    solution_summary: nonEmptyText.optional(),
    evidence: boundedTextArray,
    links: linksArray.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === 'blocked') {
      if (value.blocker_resolve_requests.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocker_resolve_requests'],
          message: 'must contain at least 1 item when decision is "blocked"',
        });
      }
      if (value.clarification_questions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['clarification_questions'],
          message: 'must be empty when decision is "blocked"',
        });
      }
      if (value.evidence.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence'],
          message: 'must be empty when decision is "blocked"',
        });
      }
      if (typeof value.solution_summary === 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['solution_summary'],
          message: 'is disallowed when decision is "blocked"',
        });
      }
    }

    if (value.decision === 'uncertain') {
      if (value.clarification_questions.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['clarification_questions'],
          message: 'must contain at least 1 item when decision is "uncertain"',
        });
      }
      if (value.blocker_resolve_requests.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocker_resolve_requests'],
          message: 'must be empty when decision is "uncertain"',
        });
      }
      if (value.evidence.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence'],
          message: 'must be empty when decision is "uncertain"',
        });
      }
      if (typeof value.solution_summary === 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['solution_summary'],
          message: 'is disallowed when decision is "uncertain"',
        });
      }
    }

    if (value.decision === 'completed') {
      if (!value.solution_summary) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['solution_summary'],
          message: 'is required when decision is "completed"',
        });
      }
      if (value.evidence.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence'],
          message: 'must contain at least 1 item when decision is "completed"',
        });
      }
      if (value.clarification_questions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['clarification_questions'],
          message: 'must be empty when decision is "completed"',
        });
      }
      if (value.blocker_resolve_requests.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocker_resolve_requests'],
          message: 'must be empty when decision is "completed"',
        });
      }
    }
  });

export type WorkerResultDecision = z.infer<typeof WorkerResultSchema>['decision'];
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

function formatLinks(links: WorkerResult['links']): string {
  const items = links ?? [];
  if (items.length === 0) return '1. (none)';
  return items
    .map((l, idx) => {
      const title = String(l.title ?? '').trim() || `Link ${idx + 1}`;
      const url = String(l.url ?? '').trim();
      return `${idx + 1}. [${title}](${url})`;
    })
    .join('\n');
}


export type WorkerResultValidation =
  | { ok: true; value: WorkerResult }
  | { ok: false; errors: string[] };

function pathToText(path: PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : String(segment)))
    .join('.');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function validateWorkerResult(raw: string): WorkerResultValidation {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.trim());
  } catch (error: any) {
    return {
      ok: false,
      errors: [`Invalid JSON syntax: ${error?.message ?? String(error)}`],
    };
  }

  const result = WorkerResultSchema.safeParse(parsedJson);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  const errors = uniqueStrings(
    result.error.issues.map((issue) => `${pathToText(issue.path)}: ${issue.message}`),
  );
  return { ok: false, errors };
}

export function buildWorkerSchemaRetryPrompt(errors: string[]): string {
  const allErrors = errors.length > 0 ? errors : ['Unknown schema validation error.'];
  return [
    'WORKER_RESULT_JSON_RETRY_REQUEST',
    'Your previous JSON response is invalid against the strict schema.',
    'Validation errors (all):',
    ...allErrors.map((error, index) => `${index + 1}. ${error}`),
    '',
    WORKER_RESULT_JSON_SCHEMA_CONTRACT,
  ].join('\n');
}

function numberedList(items: string[]): string {
  if (items.length === 0) return '1. (none)';
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

export function formatWorkerResultComment(result: WorkerResult): string {
  const sections: string[] = [
    `Worker decision: ${result.decision}`,
    '',
    'Completed steps:',
    numberedList(result.completed_steps),
  ];

  if (result.links && result.links.length > 0) {
    sections.push('', 'Links:', formatLinks(result.links));
  }

  if (result.decision === 'completed') {
    sections.push('', 'Solution summary:', result.solution_summary ?? '', '', 'Evidence:', numberedList(result.evidence));
  }
  if (result.decision === 'blocked') {
    sections.push('', 'Blocker resolve requests:', numberedList(result.blocker_resolve_requests));
  }
  if (result.decision === 'uncertain') {
    sections.push('', 'Clarification questions:', numberedList(result.clarification_questions));
  }

  return sections.join('\n').trim();
}

export function formatForcedBlockedComment(validationErrors: string[]): string {
  return [
    'Worker output could not be validated after 3 attempts; moving this ticket to blocked.',
    '',
    'Validation errors from latest attempt:',
    ...validationErrors.map((error, index) => `${index + 1}. ${error}`),
    '',
    'Human action requested: provide clarification and rerun workflow-loop.',
  ].join('\n');
}
