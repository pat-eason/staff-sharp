/**
 * Runs the same agents on the user's Claude Code subscription through the Claude Agent SDK.
 * Reused from standup-buddy; every option below was learned from a spike there:
 * - strictMcpConfig: without it the user's own MCP servers connect mid-run and inject ~100k tokens.
 * - a scrubbed env (env.ts): ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / CLAUDE_CODE_* would silently switch billing.
 * - never CLAUDE_CODE_SIMPLE (bare mode): it skips the stored login.
 * - strip `$schema` from JSON Schemas passed to outputFormat; allow maxTurns >= 3 for structured output.
 */
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { toJsonSchema } from '@valibot/to-json-schema';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import type { AgentConfig } from '../config.ts';
import { SPECS, type Kind } from '../prompts/index.ts';
import { normalizeGenerated } from '../prompts/schemas.ts';
import { CLEAN_ENV } from './env.ts';

export class RunnerError extends Error {}

// An empty directory so no project files, CLAUDE.md or memory are ever picked up.
const WORKDIR = mkdtempSync(join(tmpdir(), 'staff-sharp-claude-'));

const STRUCTURED_NOTE =
  '\n\nDeliver the final result with the StructuredOutput tool. Wherever these instructions say to call a submit_* tool, call StructuredOutput instead.';

const EFFORT = { minimal: 'low', low: 'low', medium: 'medium', high: 'high' } as const;

function baseOptions(cfg: AgentConfig, model: string): Options {
  const opts: Options = {
    model,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    cwd: WORKDIR,
    env: CLEAN_ENV,
  };
  if (cfg.thinkingLevel === 'off') opts.thinking = { type: 'disabled' };
  else opts.effort = EFFORT[cfg.thinkingLevel] ?? 'low';
  return opts;
}

function friendly(text: string): string {
  if (/not logged in|\/login|authentication|oauth|credentials/i.test(text)) {
    return 'Claude Code is not signed in. Open Settings → Model provider and link your Claude subscription.';
  }
  if (/rate.?limit|usage limit|limit reached|overloaded/i.test(text)) {
    return `Your Claude subscription hit a usage limit: ${text.slice(0, 200)}`;
  }
  return text.slice(0, 500);
}

function fail(err: unknown): never {
  if (err instanceof RunnerError) throw err;
  throw new RunnerError(friendly(err instanceof Error ? err.message : String(err)));
}

export const KINDS = Object.keys(SPECS) as Kind[];

/** One-shot structured run. Returns the validated result. */
export async function runStructured(kind: Kind, cfg: AgentConfig, message: string): Promise<unknown> {
  const spec = SPECS[kind];
  const { $schema: _ignored, ...schema } = toJsonSchema(spec.schema as never, { errorMode: 'ignore' }) as Record<string, unknown>;
  try {
    for await (const m of query({
      prompt: message,
      options: {
        ...baseOptions(cfg, spec.model(cfg)),
        systemPrompt: spec.prompt(cfg) + STRUCTURED_NOTE,
        outputFormat: { type: 'json_schema', schema },
        maxTurns: 4,
      },
    })) {
      if (m.type !== 'result') continue;
      if (m.subtype !== 'success' || m.is_error) {
        throw new RunnerError(friendly(('result' in m && typeof m.result === 'string' && m.result) || `run ended: ${m.subtype}`));
      }
      const parsed = v.safeParse(spec.schema, m.structured_output);
      if (!parsed.success) throw new RunnerError('The model returned a result that did not match the expected shape.');
      return kind === 'generate' ? normalizeGenerated(parsed.output as never) : parsed.output;
    }
  } catch (err) {
    fail(err);
  }
  throw new RunnerError('The model finished without returning a result.');
}

/** Tiny request used by Settings → Test connection and `--check`. */
export async function ping(cfg: AgentConfig): Promise<string> {
  try {
    for await (const m of query({
      prompt: 'Reply with the single word: ready',
      options: { ...baseOptions({ ...cfg, thinkingLevel: 'off' }, cfg.graderModel), maxTurns: 1 },
    })) {
      if (m.type !== 'result') continue;
      if (m.subtype !== 'success' || m.is_error) throw new RunnerError(friendly(('result' in m && m.result) || m.subtype));
      return m.result.trim();
    }
  } catch (err) {
    fail(err);
  }
  throw new RunnerError('No reply from Claude Code.');
}
