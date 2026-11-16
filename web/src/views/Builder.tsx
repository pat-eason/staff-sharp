import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useDeferredValue, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Field, Knob, Lcd, Seg, Spinner, Toggle, useAction } from '../components/ui';
import { useMeta, useProfile } from '../hooks';
import type { RegimentConfig } from '../types';
import { DIFFICULTY_NAMES, DIFFICULTY_SHORT } from '../types';

type Preset = { key: string; name: string; blurb: string; config: Partial<RegimentConfig> };

/** Lists from the server can be missing on older data; the builder always works on complete arrays. */
function complete(c: Partial<RegimentConfig>): RegimentConfig {
  return { ...BASE, ...c, domains: c.domains ?? [], types: c.types ?? [] };
}

const BASE: RegimentConfig = {
  domains: [], types: [], difficultyMin: 2, difficultyMax: 4, days: 1, perDay: 5, timed: false, timeLimitMinutes: 0,
  feedback: 'immediate', adaptive: true, generatedPerDay: 0,
};

export const PRESETS: Preset[] = [
  { key: 'quick', name: 'Quick drill', blurb: 'One question, instant feedback.', config: { perDay: 1, days: 1 } },
  { key: 'daily', name: 'Daily five', blurb: 'Five mixed questions, about 15 minutes.', config: { perDay: 5, days: 1 } },
  { key: 'speed', name: 'Speed round', blurb: '10 quick-fire questions in 12 minutes.', config: { perDay: 10, days: 1, timed: true, timeLimitMinutes: 12, types: ['mcq', 'multi', 'numeric'], feedback: 'end' } },
  { key: 'loop', name: 'Interview loop', blurb: 'Design, code review, leadership: 75 minutes on the clock.', config: { perDay: 5, days: 1, timed: true, timeLimitMinutes: 75, types: ['diagram', 'code_review', 'free_text', 'numeric', 'bug_hunt'], difficultyMin: 3, difficultyMax: 5, feedback: 'end', adaptive: false } },
  { key: 'week', name: 'Weak-spot week', blurb: 'Seven days, four a day, adapting as you go.', config: { days: 7, perDay: 4, adaptive: true } },
  { key: 'month', name: 'Thirty-day sharpening', blurb: 'A month of daily threes across every domain.', config: { days: 30, perDay: 3, adaptive: true, difficultyMin: 1, difficultyMax: 5 } },
];

export default function Builder() {
  const meta = useMeta().data;
  const profile = useProfile().data;
  const nav = useNavigate();
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  const [cfg, setCfg] = useState<RegimentConfig>(BASE);
  const [preset, setPreset] = useState('daily');
  const deferred = useDeferredValue(cfg);
  const preview = useQuery({ queryKey: ['preview', deferred], queryFn: () => api.preview(deferred) });
  const llm = meta?.llm.active ?? false;

  const patch = (p: Partial<RegimentConfig>) => setCfg((c) => ({ ...c, ...p }));
  const applyPreset = (p: Preset) => {
    setPreset(p.key);
    setCfg(complete({ ...p.config, preset: p.key }));
    setName(p.name);
  };
  const tuned = () =>
    run(async () => {
      const rec = await api.recommend();
      setPreset('tuned');
      setCfg(complete(rec.config));
      setName(rec.name);
    });
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const create = (startNow: boolean) =>
    run(async () => {
      const r = await api.createRegiment(name || 'Untitled regiment', '', cfg);
      nav(startNow ? `/sessions/${r.sessions[0].id}` : `/regiments/${r.id}`);
    });

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <div className="eyebrow">New regiment</div>
          <h1>Build a regiment</h1>
          <p className="lede">From a single drill to a month of daily sets. Each day's questions are drawn when you start it, so later days adapt to what earlier ones revealed.</p>
        </div>
      </div>

      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.key} type="button" className={clsx('preset', preset === p.key && 'on')} onClick={() => applyPreset(p)}>
            <strong>{p.name}</strong>
            <span>{p.blurb}</span>
          </button>
        ))}
        <button type="button" className={clsx('preset', 'tuned', preset === 'tuned' && 'on')} onClick={tuned} disabled={busy}>
          <strong>Tuned for me</strong>
          <span>Built from your profile and weakest measured areas.</span>
        </button>
      </div>

      <div className="builder">
        <div className="stack lg">
          <div className="glass stack">
            <Field label="Name" htmlFor="rname"><input id="rname" className="input" value={name} placeholder="Name this regiment" onChange={(e) => setName(e.target.value)} /></Field>
            <div className="knobs">
              <Knob label="Days" value={cfg.days} min={1} max={30} onChange={(days) => patch({ days })} />
              <Knob label="Per day" value={cfg.perDay} min={1} max={20} onChange={(perDay) => patch({ perDay, generatedPerDay: Math.min(cfg.generatedPerDay, perDay) })} />
              <Knob label="Min level" value={cfg.difficultyMin} min={1} max={5} format={(v) => DIFFICULTY_SHORT[v]}
                onChange={(difficultyMin) => patch({ difficultyMin, difficultyMax: Math.max(difficultyMin, cfg.difficultyMax) })} />
              <Knob label="Max level" value={cfg.difficultyMax} min={1} max={5} format={(v) => DIFFICULTY_SHORT[v]}
                onChange={(difficultyMax) => patch({ difficultyMax, difficultyMin: Math.min(difficultyMax, cfg.difficultyMin) })} />
            </div>
          </div>

          <div className="glass stack">
            <div className="row between wrap">
              <h3>Domains</h3>
              <div className="row small">
                <button type="button" className="btn sm ghost" onClick={() => patch({ domains: [] })}>All</button>
                {profile && profile.focalDomains.length > 0 && (
                  <button type="button" className="btn sm ghost" onClick={() => patch({ domains: [...profile.focalDomains] })}>My focal points</button>
                )}
              </div>
            </div>
            <p className="hint" style={{ margin: 0 }}>{cfg.domains.length === 0 ? 'Every domain is in play, weighted toward your focal points (●) and primary focus (★).' : `${cfg.domains.length} selected.`}</p>
            <div className="row wrap">
              {meta?.taxonomy.domains.map((d) => (
                <button key={d.key} type="button" className={clsx('chip', cfg.domains.includes(d.key) && 'on')} data-tip={d.blurb}
                  onClick={() => patch({ domains: toggleIn(cfg.domains, d.key) })}>
                  {profile?.primaryFocus === d.key ? <span className="star">★</span> : profile?.focalDomains.includes(d.key) ? <span className="star">●</span> : null}
                  {d.name}
                </button>
              ))}
            </div>
            <h3 style={{ marginTop: 10 }}>Question types</h3>
            <div className="row wrap">
              {meta?.taxonomy.types.map((t) => (
                <button key={t.key} type="button" className={clsx('chip', cfg.types.includes(t.key) && 'on')}
                  onClick={() => patch({ types: toggleIn(cfg.types, t.key) })}>
                  {t.name}
                </button>
              ))}
            </div>
            <p className="hint" style={{ margin: 0 }}>{cfg.types.length === 0 ? 'All types.' : 'Only the selected types.'}</p>
          </div>

          <div className="glass stack">
            <h3>Clock and feedback</h3>
            <Toggle checked={cfg.timed} onChange={(timed) => patch({ timed, feedback: timed ? 'end' : 'immediate' })} label="Timed"
              hint="A chronograph runs in the corner. Pause hides the questions." />
            {cfg.timed && (
              <div className="row wrap" style={{ alignItems: 'flex-start', gap: 24 }}>
                <Knob label="Minutes per day" value={cfg.timeLimitMinutes} min={0} max={180} step={5} format={(v) => (v === 0 ? 'auto' : `${v}m`)}
                  onChange={(timeLimitMinutes) => patch({ timeLimitMinutes })} />
                <p className="hint" style={{ maxWidth: 320 }}>“auto” sets the budget to the questions' estimated times. With a fixed budget, the day is filled to fit it.</p>
              </div>
            )}
            <div className="row wrap">
              <span className="label">Feedback</span>
              <Seg ariaLabel="Feedback timing" value={cfg.feedback} onChange={(feedback) => patch({ feedback })}
                options={[{ value: 'immediate', label: 'After each answer' }, { value: 'end', label: 'At the end' }]} />
            </div>
            <Toggle checked={cfg.adaptive} onChange={(adaptive) => patch({ adaptive })} label="Adaptive"
              hint="Weight later days toward the domains you are weakest in." />
            <div className="row wrap" style={{ alignItems: 'center' }}>
              <Toggle checked={cfg.generatedPerDay > 0} disabled={!llm}
                onChange={(on) => patch({ generatedPerDay: on ? Math.min(2, cfg.perDay) : 0 })}
                label="Fresh AI scenarios" hint={llm ? 'The model writes new questions tailored to your stack.' : 'Needs a model provider (Settings).'} />
              {cfg.generatedPerDay > 0 && (
                <Seg<number> ariaLabel="Scenarios per day" value={cfg.generatedPerDay} onChange={(generatedPerDay) => patch({ generatedPerDay })}
                  options={[1, 2, 3].filter((n) => n <= cfg.perDay).map((n) => ({ value: n, label: `${n}/day` }))} />
              )}
            </div>
          </div>
        </div>

        <aside className="builder-side">
          <div className="glass stack">
            <span className="eyebrow">Preview</span>
            {preview.isLoading ? <Spinner /> : preview.error ? (
              <p className="muted">{(preview.error as Error).message}</p>
            ) : preview.data && (
              <>
                <div className="row wrap">
                  <Lcd label="Matching" value={preview.data.matching} hot={preview.data.matching === 0} />
                  <Lcd label="Min / day" value={preview.data.minutesPerDay} />
                  <Lcd label="Total" value={preview.data.totalQuestions} />
                </div>
                {!preview.data.enoughForAllDays && preview.data.matching > 0 && (
                  <p className="small muted">Fewer matching questions than the plan needs; later days will repeat older misses or come up short. Widen the filters or add AI scenarios.</p>
                )}
                <p className="small muted" style={{ margin: 0 }}>
                  {cfg.days} day{cfg.days > 1 ? 's' : ''} × {cfg.perDay} question{cfg.perDay > 1 ? 's' : ''}
                  {cfg.timed ? `, timed${cfg.timeLimitMinutes ? ` at ${cfg.timeLimitMinutes} min` : ''}` : ''}, levels {DIFFICULTY_NAMES[cfg.difficultyMin]} to {DIFFICULTY_NAMES[cfg.difficultyMax]}.
                </p>
              </>
            )}
            <button type="button" className="btn primary lg" disabled={busy || preview.data?.matching === 0} onClick={() => create(true)}>Create and start</button>
            <button type="button" className="btn light" disabled={busy || preview.data?.matching === 0} onClick={() => create(false)}>Create, start later</button>
          </div>
        </aside>
      </div>
    </div>
  );
}
