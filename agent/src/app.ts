import './provider.ts';
import { init, observe } from '@flue/runtime';
import { Hono } from 'hono';
import { Debriefer } from './agents/debriefer.ts';
import { Grader } from './agents/grader.ts';
import { Insighter } from './agents/insighter.ts';
import { Writer } from './agents/writer.ts';
import { INTERNAL_TOKEN, refreshConfig } from './config.ts';
import { captures } from './results.ts';

/**
 * Flue agent service (Anthropic API key provider). The Go API calls POST /run/:kind with a fully built
 * message; the agent runs one model turn that ends in a terminating submit tool, and the structured
 * result goes back as JSON. Only the api service can reach this port.
 */
const app = new Hono();

// A failed run rejects with a generic message; the real reason rides the settlement event.
const failureReasons = new Map<string, string>();
observe((event: any) => {
  if (event.type !== 'submission_settled' || !event.error) return;
  failureReasons.set(event.submissionId, event.error.meta?.reason ?? event.error.message ?? 'unknown error');
  if (failureReasons.size > 200) failureReasons.delete(failureReasons.keys().next().value as string);
});

function describe(err: unknown): string {
  const submissionId = (err as { submissionId?: string } | null)?.submissionId;
  const reason = submissionId ? failureReasons.get(submissionId) : undefined;
  if (reason?.includes('not configured')) return 'No Anthropic API key configured. Add one in Settings.';
  if (reason) return reason;
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return (err instanceof Error ? err.message : String(err)) + cause;
}

app.get('/healthz', (c) => c.json({ status: 'ok' }));

const RUNNERS = { grade: Grader, generate: Writer, debrief: Debriefer, insight: Insighter } as const;

app.post('/run/:kind', async (c) => {
  if (c.req.header('x-internal-token') !== INTERNAL_TOKEN) return c.json({ error: 'unauthorized' }, 401);
  const kind = c.req.param('kind') as keyof typeof RUNNERS;
  const agent = RUNNERS[kind];
  if (!agent) return c.json({ error: `unknown run kind: ${kind}` }, 404);

  const body = (await c.req.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!body?.id || !body.message) return c.json({ error: 'id and message are required' }, 400);

  const started = Date.now();
  try {
    await refreshConfig(true);
    const handle = init(agent, { id: body.id });
    const receipt = await handle.dispatch(body.message);
    const reply = await handle.read(receipt);
    const result = captures.get(body.id);
    if (!result) {
      return c.json({ error: `The model finished without returning a result. ${reply.text ?? ''}`.trim() }, 502);
    }
    console.log(JSON.stringify({ msg: 'run', operation: `run.${kind}`, id: body.id, durationMs: Date.now() - started }));
    return c.json({ result });
  } catch (err) {
    const message = describe(err);
    console.error(JSON.stringify({ msg: 'run failed', operation: `run.${kind}`, id: body.id, durationMs: Date.now() - started, error: message }));
    return c.json({ error: message }, 502);
  } finally {
    captures.delete(body.id);
  }
});

export default app;
