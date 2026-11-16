/**
 * Claude Code runner: the `claude-runner` compose service the Go API calls when the provider is
 * "Claude Code subscription". The login lives in its volume and is linked from Settings (auth.ts).
 * Stateless: the Go API sends the settings with every request. Reused from standup-buddy.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DEFAULT_CONFIG, type AgentConfig } from '../config.ts';
import type { Kind } from '../prompts/index.ts';
import * as auth from './auth.ts';
import { KINDS, ping, RunnerError, runStructured } from './sdk.ts';

const PORT = Number(process.env.SUBSCRIPTION_PORT ?? 3100);
const HOST = process.env.SUBSCRIPTION_HOST ?? '127.0.0.1';
const TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

function withDefaults(raw: unknown): AgentConfig {
  return { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? (raw as Partial<AgentConfig>) : {}), apiKey: '' };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 << 20) throw new RunnerError('request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new RunnerError('invalid JSON body');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'ok', provider: 'claude-code' });
  if (req.headers['x-internal-token'] !== TOKEN) return send(res, 401, { error: 'unauthorized' });
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

  try {
    const body = await readJson(req);

    if (url.pathname === '/auth/status') return send(res, 200, await auth.status());
    if (url.pathname === '/auth/login') return send(res, 200, await auth.start());
    if (url.pathname === '/auth/code') return send(res, 200, await auth.submit(String(body.code ?? '')));
    if (url.pathname === '/auth/logout') {
      await auth.logout();
      return send(res, 200, await auth.status());
    }

    const cfg = withDefaults(body.config);
    if (url.pathname === '/test') return send(res, 200, { reply: await ping(cfg) });

    const run = url.pathname.match(/^\/run\/([a-z]+)$/);
    if (run && KINDS.includes(run[1] as Kind)) {
      if (typeof body.message !== 'string' || !body.message) return send(res, 400, { error: 'message is required' });
      const started = Date.now();
      const result = await runStructured(run[1] as Kind, cfg, body.message);
      console.log(JSON.stringify({ msg: 'run', operation: `run.${run[1]}`, id: body.id, durationMs: Date.now() - started }));
      return send(res, 200, { result });
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ msg: 'request failed', operation: url.pathname, error: message }));
    if (!res.headersSent) send(res, err instanceof RunnerError || err instanceof auth.AuthError ? 502 : 500, { error: message });
    else res.end();
  }
}

if (process.argv.includes('--check')) {
  ping(DEFAULT_CONFIG).then(
    (reply) => console.log(`OK: Claude Code replied "${reply}" on your subscription.`),
    (err) => {
      console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    },
  );
} else {
  createServer((req, res) => void handle(req, res)).listen(PORT, HOST, () => {
    console.log(`[staff-sharp] Claude Code runner listening on http://${HOST}:${PORT}`);
  });
}
