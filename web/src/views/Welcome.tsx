import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { LANG_NAMES } from '../components/highlight';
import { Field, Knob, Lcd, Meter, pct, Seg, Spinner, useAction } from '../components/ui';
import { domainName, keys, useMeta, useProfile } from '../hooks';
import type { Lang, Meta, Profile } from '../types';
import { GOALS, LEVELS } from '../types';

const STEPS = [
  { key: 'about', label: 'About you' },
  { key: 'focus', label: 'Focus' },
  { key: 'calibrate', label: 'Calibration' },
  { key: 'result', label: 'Your level' },
] as const;
type Step = (typeof STEPS)[number]['key'];

/**
 * First-run survey: who you are, what to hone, then a 15-minute calibration quiz whose results set the
 * starting level. Reads and writes `?step=` so a refresh or the quiz round trip lands on the right step.
 */
export default function Welcome() {
  const meta = useMeta().data;
  const profile = useProfile().data;
  const calibration = useQuery({ queryKey: ['onboarding'], queryFn: api.onboarding });
  const [params, setParams] = useSearchParams();
  if (!meta || !profile || calibration.isLoading) return <div className="empty"><Spinner /></div>;

  const fallback: Step = calibration.data?.status === 'completed' ? 'result' : calibration.data ? 'calibrate' : 'about';
  const step = (STEPS.find((s) => s.key === params.get('step'))?.key ?? fallback) as Step;
  const go = (s: Step) => setParams({ step: s });
  const at = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="stack lg" style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Welcome · step {at + 1} of {STEPS.length}</div>
          <h1>{{ about: "Let's find where your edge has dulled", focus: 'What do you want to hone?', calibrate: 'A quick calibration', result: 'Your starting level' }[step]}</h1>
          <p className="lede">
            {step === 'about' && `${meta.bank.total} questions across ${meta.taxonomy.domains.length} domains. A few answers about you, then a 15-minute quiz, and every regiment is built from the result.`}
            {step === 'focus' && 'Focal points are weighted up everywhere and marked on your star plot. Pick the one area you want to work hardest on as your primary focus.'}
            {step === 'calibrate' && 'Twelve questions, one per domain, spread from senior to principal level. It takes about 15 minutes and grades instantly.'}
            {step === 'result' && 'Estimated from which levels of question you got right. You can accept it or set your own.'}
          </p>
        </div>
      </div>
      <ol className="wizard-steps" aria-label="Onboarding steps">
        {STEPS.map((s, i) => (
          <li key={s.key} className={clsx(i < at && 'done', i === at && 'current')}><span>{i + 1}</span>{s.label}</li>
        ))}
      </ol>
      {step === 'about' && <About meta={meta} profile={profile} onNext={() => go('focus')} />}
      {step === 'focus' && <Focus meta={meta} profile={profile} onBack={() => go('about')} onNext={() => go('calibrate')} />}
      {step === 'calibrate' && <Calibrate status={calibration.data?.status} sessionId={calibration.data?.sessionId} profile={profile} onBack={() => go('focus')} />}
      {step === 'result' && <Result meta={meta} profile={profile} />}
    </div>
  );
}

/** Saves the profile draft (still not onboarded) and moves on. */
function useSaveDraft() {
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const save = (p: Profile, then: () => void) =>
    run(async () => {
      qc.setQueryData(keys.profile, await api.saveProfile(p));
      then();
    });
  return { save, busy };
}

function About({ meta, profile, onNext }: { meta: Meta; profile: Profile; onNext: () => void }) {
  const [p, setP] = useState(profile);
  const { save, busy } = useSaveDraft();
  return (
    <div className="glass stack lg">
      <div className="grid two">
        <Field label="Your name" htmlFor="wname">
          <input id="wname" className="input" autoFocus value={p.displayName} placeholder="What should the coach call you?" onChange={(e) => setP({ ...p, displayName: e.target.value })} />
        </Field>
        <div className="row wrap" style={{ gap: 28 }}>
          <Knob label="Years in the industry" value={p.yearsExperience} min={0} max={40} onChange={(yearsExperience) => setP({ ...p, yearsExperience })} />
          <Knob label="Practice minutes / week" value={p.weeklyMinutes} min={15} max={600} step={15} onChange={(weeklyMinutes) => setP({ ...p, weeklyMinutes })} />
        </div>
      </div>
      <Field label="Primary language" hint="Code questions appear in this language when a version exists.">
        <Seg<Lang> ariaLabel="Primary language" accent value={p.primaryLanguage} onChange={(primaryLanguage) => setP({ ...p, primaryLanguage })}
          options={meta.taxonomy.languages.map((l) => ({ value: l.key as Lang, label: LANG_NAMES[l.key as Lang] }))} />
      </Field>
      <Field label="Title today" hint="Self-reported; the calibration quiz gives a second opinion.">
        <Seg ariaLabel="Current level" value={p.level} onChange={(level) => setP({ ...p, level })} options={LEVELS.map((l) => ({ value: l.key, label: l.name }))} />
      </Field>
      <div className="row end">
        <button type="button" className="btn primary lg" disabled={busy || !p.displayName.trim()} onClick={() => save(p, onNext)}>Next: focus →</button>
      </div>
    </div>
  );
}

function Focus({ meta, profile, onBack, onNext }: { meta: Meta; profile: Profile; onBack: () => void; onNext: () => void }) {
  const [p, setP] = useState(profile);
  const { save, busy } = useSaveDraft();
  const toggle = (k: string) => setP({ ...p, focalDomains: p.focalDomains.includes(k) ? p.focalDomains.filter((x) => x !== k) : [...p.focalDomains, k] });
  return (
    <div className="glass stack lg">
      <Field label="Focal points" hint="Pick two to five areas you want more practice in.">
        <div className="row wrap">
          {meta.taxonomy.domains.map((d) => (
            <button key={d.key} type="button" className={clsx('chip', p.focalDomains.includes(d.key) && 'on')} data-tip={d.blurb} onClick={() => toggle(d.key)}>
              {p.focalDomains.includes(d.key) && <span className="star">●</span>}{d.name}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Primary focus" hint="The one area you want to hone the hardest. Weighted twice as heavily, marked ★.">
        <div className="row wrap">
          {meta.taxonomy.domains.map((d) => (
            <button key={d.key} type="button" className={clsx('chip', p.primaryFocus === d.key && 'on')} data-tip={d.blurb}
              onClick={() => setP({ ...p, primaryFocus: p.primaryFocus === d.key ? '' : d.key })}>
              {p.primaryFocus === d.key && <span className="star">★</span>}{d.name}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Staff archetype (optional)" hint="From Will Larson's Staff Engineer. Shapes the coach's advice.">
        <div className="grid four">
          {meta.taxonomy.archetypes.map((a) => (
            <button key={a.key} type="button" className={clsx('preset', p.archetype === a.key && 'on')} onClick={() => setP({ ...p, archetype: p.archetype === a.key ? '' : a.key })}>
              <strong>{a.name}</strong><span>{a.blurb}</span>
            </button>
          ))}
        </div>
      </Field>
      <div className="grid two">
        <Field label="Goal">
          <Seg ariaLabel="Goal" value={p.goal} onChange={(goal) => setP({ ...p, goal })} options={GOALS.map((g) => ({ value: g.key, label: g.name, tip: g.blurb }))} />
        </Field>
        <Field label="Your stack (optional)" htmlFor="wstack" hint="Fresh AI scenarios use it as material.">
          <input id="wstack" className="input" value={p.stack} placeholder="Go, Postgres, Kafka, Kubernetes on AWS…" onChange={(e) => setP({ ...p, stack: e.target.value })} />
        </Field>
      </div>
      <div className="row between">
        <button type="button" className="btn ghost" onClick={onBack}>← Back</button>
        <button type="button" className="btn primary lg" disabled={busy || p.focalDomains.length === 0} onClick={() => save(p, onNext)}>Next: calibration →</button>
      </div>
    </div>
  );
}

function Calibrate({ status, sessionId, profile, onBack }: { status?: string; sessionId?: string; profile: Profile; onBack: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const start = () =>
    run(async () => {
      const ref = sessionId && status !== 'completed' ? { sessionId } : await api.startCalibration();
      nav(`/sessions/${ref.sessionId}`);
    });
  const skip = () =>
    run(async () => {
      qc.setQueryData(keys.profile, await api.saveProfile({ ...profile, onboarded: true }));
      nav('/');
    });
  return (
    <div className="porcelain stack lg">
      <div className="grid three">
        <div className="focus-area"><strong>12 questions</strong><span className="small muted">One per domain, multiple choice, select-all, estimation and ordering. No writing.</span></div>
        <div className="focus-area"><strong>About 15 minutes</strong><span className="small muted">The chronograph keeps time. Either pusher pauses it, and the question hides while paused.</span></div>
        <div className="focus-area"><strong>Mixed levels</strong><span className="small muted">Three questions each at strong-senior, staff, senior-staff and principal level, easiest first.</span></div>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Answer honestly and use the confidence buttons: a confident miss tells the coach more than a lucky guess. The questions get
        harder as you go. Any you don't reach before the 15 minutes are up are left out of the estimate, so keep a steady pace
        rather than rushing.
      </p>
      <div className="row between wrap">
        <button type="button" className="btn ghost" onClick={onBack}>← Back</button>
        <div className="row">
          <button type="button" className="btn ghost" disabled={busy} onClick={skip}>Skip for now</button>
          <button type="button" className="btn primary lg" disabled={busy} onClick={start}>
            {status === 'in_progress' ? 'Continue the calibration' : 'Start the 15-minute calibration'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Result({ meta, profile }: { meta: Meta; profile: Profile }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const { data: res, isLoading, error } = useQuery({ queryKey: ['calibration-result'], queryFn: api.calibrationResult });
  const [level, setLevel] = useState<Profile['level'] | null>(null);
  if (isLoading) return <div className="empty"><Spinner /></div>;
  if (error || !res) return <div className="glass empty">{(error as Error)?.message ?? 'No calibration yet.'}</div>;
  const chosen = level ?? (res.answered < 3 ? profile.level : res.level);
  const finish = () =>
    run(async () => {
      qc.setQueryData(keys.profile, await api.saveProfile({ ...profile, level: chosen, onboarded: true }));
      await Promise.all([qc.invalidateQueries({ queryKey: keys.stats }), qc.invalidateQueries({ queryKey: keys.insight })]);
      nav('/');
    });
  const estimated = LEVELS.find((l) => l.key === res.level)?.name;
  const retake = () =>
    run(async () => {
      const ref = await api.startCalibration();
      await qc.invalidateQueries({ queryKey: ['onboarding'] });
      nav(`/sessions/${ref.sessionId}`);
    });
  const tooFew = res.answered < 3;

  return (
    <div className="stack lg">
      <div className="grid two">
        <div className="glass stack">
          <span className="eyebrow">Estimate</span>
          <h2>{tooFew ? 'Not enough answers yet' : estimated}</h2>
          {tooFew && (
            <div className="row wrap">
              <p className="small muted" style={{ margin: 0 }}>Answer at least a few questions for an estimate, or set your level below.</p>
              <button type="button" className="btn sm primary" disabled={busy} onClick={retake}>Retake the calibration</button>
            </div>
          )}
          <div className="row wrap">
            <Lcd label="Ability" value={res.theta.toFixed(1)} unit="/5" big />
            <Lcd label="Accuracy" value={pct(res.accuracy)} unit="%" big />
            <Lcd label="Answered" value={`${res.answered}/12`} />
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Confidence: {res.confidence}. {res.confidence !== 'high' && 'With fewer answers the estimate leans toward staff level; it sharpens as you practise.'}
            {' '}Your title today: {LEVELS.find((l) => l.key === profile.level)?.name}.
          </p>
        </div>
        <div className="glass stack sm">
          <span className="eyebrow">By question level</span>
          {res.byDifficulty.length === 0 && <p className="small muted">No answered questions to break down.</p>}
          {res.byDifficulty.map((b) => (
            <div key={b.key} className="bar-row">
              <span className="bar-name">{b.name}</span>
              <div className="grow"><Meter value={b.accuracy} label={`${b.name} accuracy`} /></div>
              <span className="bar-val mono">{pct(b.accuracy)}</span>
              <span className="faint small">n={b.count}</span>
            </div>
          ))}
          {(res.strongest?.length ?? 0) > 0 && <p className="small" style={{ margin: '8px 0 0' }}><strong>Sharpest:</strong> {res.strongest?.map((d) => domainName(meta, d)).join(', ')}</p>}
          {(res.weakest?.length ?? 0) > 0 && <p className="small" style={{ margin: 0 }}><strong>Missed:</strong> {res.weakest?.map((d) => domainName(meta, d)).join(', ')}</p>}
        </div>
      </div>
      <div className="porcelain stack">
        <span className="label">Set your level</span>
        <p className="small muted" style={{ margin: 0 }}>Questions are picked around this level. You can change it any time on your profile.</p>
        <Seg ariaLabel="Level" value={chosen} onChange={setLevel}
          options={LEVELS.map((l) => ({ value: l.key, label: l.key === res.level && !tooFew ? `${l.name} ✦` : l.name }))} />
        <div className="row end">
          <button type="button" className="btn ghost" onClick={() => nav(`/regiments/${res.regimentId}`)}>Review the answers</button>
          <button type="button" className="btn primary lg" disabled={busy} onClick={finish}>Finish and see my briefing</button>
        </div>
      </div>
    </div>
  );
}
