import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { api } from '../api';
import { Field, Seg, Spinner, useAction, useToast } from '../components/ui';
import { keys, useSettings } from '../hooks';
import type { LlmProvider, Settings as S } from '../types';
import { MODEL_OPTIONS } from '../types';
import CodeView from '../components/CodeView';
import { CODE_THEMES, useAppearance } from '../theme';

const PROVIDERS: { key: LlmProvider; name: string; blurb: string }[] = [
  { key: 'off', name: 'No model', blurb: 'Everything works offline: closed questions grade exactly, written answers get a keyword pass and you self-grade against the rubric.' },
  { key: 'claude_code', name: 'Claude Code subscription', blurb: 'Grading, coaching and fresh scenarios run on your Claude subscription through the claude-runner service. No API key.' },
  { key: 'api_key', name: 'Anthropic API key', blurb: 'The Flue agent service calls the Anthropic API with your key, stored encrypted.' },
];

export default function SettingsPage() {
  const { data: settings } = useSettings();
  if (!settings) return <div className="empty"><Spinner /></div>;
  return <SettingsForm key={settings.llmProvider} settings={settings} />;
}

function SettingsForm({ settings }: { settings: S }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { run, busy } = useAction();
  const [form, setForm] = useState(settings);
  const [apiKey, setApiKey] = useState('');
  const save = (patch: Partial<S> & { apiKey?: string }) =>
    run(async () => {
      const s = await api.saveSettings(patch);
      qc.setQueryData(keys.settings, s);
      await qc.invalidateQueries({ queryKey: keys.meta });
      setForm(s);
    }, 'Settings saved');
  const test = () =>
    run(async () => {
      const r = await api.testSettings();
      toast(`Model replied: “${r.reply}”`);
    });

  return (
    <div className="stack lg" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Model provider</h1>
          <p className="lede">The model grades written answers, diagrams and code reviews, writes fresh scenarios, and coaches you after each regiment.</p>
        </div>
      </div>

      <div className="grid three">
        {PROVIDERS.map((p) => (
          <button key={p.key} type="button" className={clsx('preset', settings.llmProvider === p.key && 'on')}
            onClick={() => save({ llmProvider: p.key })} disabled={busy}>
            <strong>{p.name}</strong><span>{p.blurb}</span>
          </button>
        ))}
      </div>

      {settings.llmProvider === 'claude_code' && <ClaudeLink />}

      {settings.llmProvider === 'api_key' && (
        <div className="glass stack">
          <h3>Anthropic API key</h3>
          <p className="muted small" style={{ margin: 0 }}>
            {settings.apiKeySource === 'stored' && `Stored key ${settings.apiKeyHint}.`}
            {settings.apiKeySource === 'env' && `Using ANTHROPIC_API_KEY from the environment (${settings.apiKeyHint}).`}
            {settings.apiKeySource === 'none' && 'No key yet.'}
          </p>
          <div className="row wrap">
            <input className="input" style={{ maxWidth: 420 }} type="password" autoComplete="off" aria-label="Anthropic API key" placeholder="sk-ant-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <button type="button" className="btn primary" disabled={busy || !apiKey.trim()} onClick={() => { save({ apiKey }); setApiKey(''); }}>Save key</button>
            {settings.apiKeySource === 'stored' && <button type="button" className="btn ghost" disabled={busy} onClick={() => save({ apiKey: '' })}>Remove</button>}
          </div>
        </div>
      )}

      {settings.llmProvider !== 'off' && (
        <div className="glass stack lg">
          <div className="row between wrap">
            <h3>Models</h3>
            <button type="button" className="btn light" disabled={busy} onClick={test}>Test connection</button>
          </div>
          <div className="grid three">
            {(['graderModel', 'generatorModel', 'coachModel'] as const).map((k) => (
              <Field key={k} label={{ graderModel: 'Grader', generatorModel: 'Scenario writer', coachModel: 'Coach' }[k]} htmlFor={k}>
                <select id={k} className="select" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}>
                  {[...new Set([form[k], ...MODEL_OPTIONS])].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <Field label="Thinking" hint="More thinking grades more carefully and takes longer.">
            <Seg ariaLabel="Thinking level" value={form.thinkingLevel} onChange={(thinkingLevel) => setForm({ ...form, thinkingLevel })}
              options={(['off', 'low', 'medium', 'high'] as const).map((v) => ({ value: v, label: v }))} />
          </Field>
          <Field label="Extra grading instructions" htmlFor="ginst" hint="For example: be strict about quantification; I am preparing for a principal loop.">
            <textarea id="ginst" className="textarea" style={{ minHeight: 80 }} value={form.graderInstructions} onChange={(e) => setForm({ ...form, graderInstructions: e.target.value })} />
          </Field>
          <div className="row end">
            <button type="button" className="btn primary" disabled={busy} onClick={() => save({
              graderModel: form.graderModel, generatorModel: form.generatorModel, coachModel: form.coachModel,
              thinkingLevel: form.thinkingLevel, graderInstructions: form.graderInstructions,
            })}>Save models</button>
          </div>
        </div>
      )}

      <Appearance />

      <div className="glass stack">
        <h3>Typography</h3>
        <p className="muted small" style={{ margin: 0 }}>
          The design uses Degular for headings and ABC Favorit for body text. Both are licensed fonts and are not bundled: drop your
          <code> .woff2</code> files into <code>web/public/fonts/</code> (see the README there) and rebuild the web service. Until then the
          app uses Bricolage Grotesque and Instrument Sans.
        </p>
      </div>
    </div>
  );
}

/** Links the Claude Code login: the API drives `claude auth login` in the runner container (from standup-buddy). */
function ClaudeLink() {
  const { run, busy } = useAction();
  const toast = useToast();
  const status = useQuery({ queryKey: ['claude-status'], queryFn: api.claudeStatus });
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const qc = useQueryClient();
  const refresh = (s: unknown) => qc.setQueryData(['claude-status'], s);

  const start = () => run(async () => setUrl(await api.claudeLogin()));
  const submit = () =>
    run(async () => {
      refresh(await api.claudeCode(code));
      setUrl(null);
      setCode('');
      toast('Claude subscription linked');
    });
  const logout = () => run(async () => refresh(await api.claudeLogout()));
  const s = status.data;

  return (
    <div className="porcelain stack">
      <div className="row between wrap">
        <h3>Claude Code subscription</h3>
        {status.isLoading ? <Spinner /> : s?.loggedIn ? (
          <span className="tag good">Linked{s.email ? ` · ${s.email}` : ''}{s.subscriptionType ? ` · ${s.subscriptionType}` : ''}</span>
        ) : (
          <span className="tag bad">{s?.runner === false ? 'Runner not running' : 'Not linked'}</span>
        )}
      </div>
      {s?.runner === false && <p className="muted small">{s.message ?? 'Start it with: docker compose up -d claude-runner'}</p>}
      {url ? (
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>1. Sign in with Claude and approve access. The page then shows a code.</p>
          <div><a className="btn primary" href={url} target="_blank" rel="noopener noreferrer">Open the Claude sign-in page</a></div>
          <p className="small muted" style={{ margin: 0 }}>2. Paste the code here.</p>
          <div className="row wrap">
            <input className="input" style={{ maxWidth: 420 }} aria-label="Sign-in code" value={code} autoComplete="off" onChange={(e) => setCode(e.target.value)} />
            <button type="button" className="btn primary" disabled={busy || !code.trim()} onClick={submit}>Link</button>
            <button type="button" className="btn ghost" onClick={() => setUrl(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="row wrap">
          <button type="button" className="btn primary" disabled={busy || s?.runner === false} onClick={start}>
            {s?.loggedIn ? 'Link a different account' : 'Link my Claude subscription'}
          </button>
          {s?.loggedIn && <button type="button" className="btn ghost" disabled={busy} onClick={logout}>Sign out</button>}
        </div>
      )}
      <p className="hint" style={{ margin: 0 }}>The login is stored in the claude_home Docker volume and used only by the claude-runner service.</p>
    </div>
  );
}

const PREVIEW = `// retry with jitter
async function fetchQuote(id: string): Promise<Quote> {
  const res = await http.get(\`/quotes/\${id}\`, { timeout: 800 });
  return parse(res.body) ?? DEFAULT_QUOTE;
}`;

/** Theme (system, light, dark) and the code color scheme, with a live preview of each scheme. */
function Appearance() {
  const { prefs, setTheme, setCodeTheme } = useAppearance();
  return (
    <div className="glass stack lg">
      <div className="row between wrap">
        <h3>Appearance</h3>
        <Seg ariaLabel="Theme" value={prefs.theme} onChange={(t) => setTheme(t)}
          options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </div>
      <div className="stack sm">
        <span className="label">Code color scheme</span>
        <div className="code-themes" role="radiogroup" aria-label="Code color scheme">
          {CODE_THEMES.map((t) => (
            <button key={t.key} type="button" role="radio" aria-checked={prefs.codeTheme === t.key}
              className={clsx('code-theme', prefs.codeTheme === t.key && 'on')} onClick={() => setCodeTheme(t.key)}>
              <div data-code-theme={t.key} className="code-theme-preview">
                <CodeView code={PREVIEW} lang="ts" comments={[]} />
              </div>
              <span className="code-theme-name">{t.name}{t.light && <span className="faint small"> · light</span>}</span>
            </button>
          ))}
        </div>
        <span className="hint">Used for every code review, bug hunt and code block. Saved to your profile.</span>
      </div>
    </div>
  );
}
