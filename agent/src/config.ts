/**
 * Settings live in the Go API's database. Agent functions render synchronously, so the latest config
 * is cached here and refreshed before every run (pattern from standup-buddy).
 */
export interface AgentConfig {
  apiKey: string;
  llmProvider: string;
  graderModel: string;
  generatorModel: string;
  coachModel: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  graderInstructions: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  apiKey: '',
  llmProvider: 'off',
  graderModel: 'claude-sonnet-5-5',
  generatorModel: 'claude-sonnet-5-5',
  coachModel: 'claude-sonnet-5-5',
  thinkingLevel: 'low',
  graderInstructions: '',
};

const API_URL = (process.env.API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
export const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
const TTL_MS = 2000;

let current: AgentConfig = { ...DEFAULT_CONFIG };
let fetchedAt = 0;
let inflight: Promise<void> | null = null;

export function getConfig(): AgentConfig {
  return current;
}

export async function refreshConfig(force = false): Promise<void> {
  if (!force && Date.now() - fetchedAt < TTL_MS) return;
  inflight ??= (async () => {
    const res = await fetch(`${API_URL}/internal/config`, {
      headers: { 'x-internal-token': INTERNAL_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
    current = { ...DEFAULT_CONFIG, ...((await res.json()) as Partial<AgentConfig>) };
    fetchedAt = Date.now();
    // The provider resolves credentials from the environment on each model call.
    if (current.apiKey) process.env.ANTHROPIC_API_KEY = current.apiKey;
    else delete process.env.ANTHROPIC_API_KEY;
  })().finally(() => {
    inflight = null;
  });
  await inflight;
}
