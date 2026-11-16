import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { LANG_NAMES } from '../components/highlight';
import StarPlot from '../components/StarPlot';
import { Field, Knob, Lcd, Markdown, Meter, pct, Seg, Spinner, useAction } from '../components/ui';
import { domainName, keys, useInsight, useMeta, useProfile, useStats } from '../hooks';
import type { Lang, Meta, Profile, ProfileStats } from '../types';
import { GOALS, LEVELS } from '../types';

export default function ProfilePage() {
  const meta = useMeta().data;
  const profile = useProfile().data;
  const stats = useStats().data;
  const [editing, setEditing] = useState(false);
  if (!meta || !profile || !stats) return <div className="empty"><Spinner /></div>;
  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <div className="eyebrow">Profile</div>
          <h1>{profile.displayName || 'Your edge'}</h1>
          <p className="lede">
            {LEVELS.find((l) => l.key === profile.level)?.name} · {profile.yearsExperience} years · {LANG_NAMES[profile.primaryLanguage]}
            {profile.archetype && ` · ${meta.taxonomy.archetypes.find((a) => a.key === profile.archetype)?.name}`}
            {profile.primaryFocus && ` · honing ${domainName(meta, profile.primaryFocus)}`}
          </p>
        </div>
        <button type="button" className="btn light" onClick={() => setEditing((e) => !e)}>{editing ? 'Close editor' : 'Edit profile'}</button>
      </div>
      {editing && <ProfileForm meta={meta} initial={profile} onSaved={() => setEditing(false)} />}
      <Sharpness meta={meta} stats={stats} />
      <InsightCard meta={meta} />
      <Breakdowns stats={stats} />
    </div>
  );
}

export function starData(stats: ProfileStats) {
  const axes = stats.domains.map((d) => ({ key: d.key, label: d.short, focal: d.focal, primary: d.primary, empty: d.count === 0 }));
  return {
    axes,
    series: [
      { name: 'Mastery', values: stats.domains.map((d) => d.mastery), tone: 'porcelain' as const },
      { name: 'Potential', values: stats.domains.map((d) => d.potential), tone: 'accent' as const },
    ],
  };
}

function Sharpness({ meta, stats }: { meta: Meta; stats: ProfileStats }) {
  const { axes, series } = starData(stats);
  return (
    <div className="profile-top">
      <div className="glass stack">
        <div className="row between wrap">
          <span className="eyebrow">Sharpness by domain</span>
          <div className="star-legend">
            <span><i style={{ background: 'var(--star-mastery)' }} />Mastery</span>
            <span><i style={{ background: 'var(--accent-hi)' }} />Potential</span>
            <span><span style={{ color: 'var(--accent-hi)' }}>●</span> focal point · <span style={{ color: 'var(--accent-hi)' }}>★</span> primary focus</span>
          </div>
        </div>
        <StarPlot axes={axes} series={series} title="Mastery and potential by domain" />
        <p className="hint" style={{ margin: 0 }}>
          Mastery weights harder questions more and fades over a 45-day half-life, so it reflects how sharp you are now. With few answers
          in a domain it stays near the middle; dashed spokes have no answers yet.
        </p>
      </div>
      <div className="stack">
        <div className="glass stack">
          <div className="grid two">
            <Lcd label="Answered" value={stats.answered} />
            <Lcd label="Streak" value={stats.streakDays} unit="d" />
            <Lcd label="Accuracy" value={pct(stats.accuracy)} unit="%" />
            <Lcd label="Potential" value={pct(stats.potential)} unit="%" />
            <Lcd label="Calibration" value={pct(stats.calibration)} unit={stats.calibration == null ? '' : '%'} />
            <Lcd label="Blind spots" value={stats.blindSpots} hot={stats.blindSpots > 0} />
          </div>
          <p className="hint" style={{ margin: 0 }}>Calibration: how well your stated confidence predicts your score. Blind spots: answers you were certain about and missed.</p>
        </div>
        <div className="glass stack sm">
          <span className="eyebrow">Domains</span>
          {stats.domains.map((d) => (
            <div key={d.key} className="bar-row">
              <span className="bar-name">{d.primary ? '★ ' : d.focal ? '● ' : ''}{d.name}</span>
              <div className="grow"><Meter value={d.mastery} label={`${d.name} mastery`} ghost={d.count === 0} /></div>
              <span className="bar-val mono">{d.count ? pct(d.mastery) : '—'}</span>
              <span className="faint small" data-tip="Answers in this domain">{d.count}{d.trend > 0.05 ? ' ↑' : d.trend < -0.05 ? ' ↓' : ''}</span>
            </div>
          ))}
          <span className="hint">{meta.bank.total} questions in the bank.</span>
        </div>
      </div>
    </div>
  );
}

function InsightCard({ meta }: { meta: Meta }) {
  const qc = useQueryClient();
  const { data: insight, isLoading } = useInsight();
  const { run, busy } = useAction();
  const refresh = () => run(async () => qc.setQueryData(keys.insight, await api.refreshInsight()));
  if (isLoading || !insight) return <div className="glass"><Spinner /></div>;
  return (
    <div className="porcelain stack">
      <div className="row between wrap">
        <div className="row">
          <span className="eyebrow">Where to focus next</span>
          <span className={clsx('tag', insight.source === 'llm' && 'accent')}>{insight.source === 'llm' ? 'AI coach' : 'Rules'}</span>
        </div>
        <button type="button" className="btn sm light" disabled={busy} onClick={refresh}>
          {busy ? 'Thinking…' : meta.llm.active ? 'Refresh with the coach' : 'Refresh'}
        </button>
      </div>
      <Markdown className="qprompt">{insight.summary}</Markdown>
      {insight.focusNext && insight.focusNext.length > 0 && (
        <div className="grid three">
          {insight.focusNext.map((f, i) => (
            <div key={i} className="focus-area">
              <strong>{domainName(meta, f.domain)}</strong>
              <span className="small muted">{f.why}</span>
              {f.practice && <span className="small">→ {f.practice}</span>}
            </div>
          ))}
        </div>
      )}
      {insight.archetypeNote && <p className="small"><strong>Archetype:</strong> {insight.archetypeNote}</p>}
      {insight.weeklyPlan && insight.weeklyPlan.length > 0 && (
        <div>
          <span className="eyebrow">This week</span>
          <ul className="tight-list">{insight.weeklyPlan.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      {!meta.llm.active && <p className="hint" style={{ margin: 0 }}>Connect a model in Settings for a written coaching summary.</p>}
    </div>
  );
}

function Breakdowns({ stats }: { stats: ProfileStats }) {
  const groups = [
    { title: 'Skills', rows: stats.skills ?? [] },
    { title: 'Question types', rows: stats.types ?? [] },
    { title: 'Language-specific questions', rows: stats.languages ?? [] },
  ].filter((g) => g.rows.length > 0);
  if (groups.length === 0 && !stats.weakConcepts?.length) return null;
  return (
    <div className="grid three">
      {groups.map((g) => (
        <div key={g.title} className="glass stack sm">
          <span className="eyebrow">{g.title}</span>
          {g.rows.map((b) => (
            <div key={b.key} className="bar-row">
              <span className="bar-name">{b.name}</span>
              <div className="grow"><Meter value={b.accuracy} label={b.name} /></div>
              <span className="bar-val mono">{pct(b.accuracy)}</span>
              <span className="faint small">{b.count}</span>
            </div>
          ))}
        </div>
      ))}
      {stats.weakConcepts && stats.weakConcepts.length > 0 && (
        <div className="glass stack sm">
          <span className="eyebrow">Weakest concepts</span>
          <div className="row wrap">{stats.weakConcepts.map((c) => <span key={c.domain + c.concept} className="tag">{c.concept.replace(/-/g, ' ')} {pct(c.accuracy)}%</span>)}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- form (also the onboarding)

export function ProfileForm({ meta, initial, onSaved, onboarding }: { meta: Meta; initial: Profile; onSaved?: () => void; onboarding?: boolean }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { run, busy } = useAction();
  const [p, setP] = useState<Profile>(initial);
  const patch = (x: Partial<Profile>) => setP((cur) => ({ ...cur, ...x }));
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = () =>
    run(async () => {
      const saved = await api.saveProfile({ ...p, onboarded: true });
      qc.setQueryData(keys.profile, saved);
      await qc.invalidateQueries({ queryKey: keys.stats });
      await qc.invalidateQueries({ queryKey: keys.insight });
      onSaved?.();
      if (onboarding) nav('/');
    }, onboarding ? undefined : 'Profile saved');

  return (
    <div className="glass stack lg">
      <div className="grid two">
        <Field label="Name" htmlFor="pname"><input id="pname" className="input" value={p.displayName} placeholder="What should the coach call you?" onChange={(e) => patch({ displayName: e.target.value })} /></Field>
        <div className="row wrap" style={{ gap: 24, alignItems: 'flex-start' }}>
          <Knob label="Years" value={p.yearsExperience} min={0} max={40} onChange={(yearsExperience) => patch({ yearsExperience })} />
          <Knob label="Minutes / week" value={p.weeklyMinutes} min={15} max={600} step={15} onChange={(weeklyMinutes) => patch({ weeklyMinutes })} />
        </div>
      </div>

      <Field label="Primary language" hint="Code questions are shown in this language when a version exists, and language-specific questions are weighted up.">
        <Seg<Lang> ariaLabel="Primary language" accent value={p.primaryLanguage} onChange={(primaryLanguage) => patch({ primaryLanguage, extraLanguages: p.extraLanguages.filter((l) => l !== primaryLanguage) })}
          options={meta.taxonomy.languages.map((l) => ({ value: l.key as Lang, label: LANG_NAMES[l.key as Lang] }))} />
      </Field>
      <Field label="Also comfortable in" hint="Their language-specific questions are included too.">
        <div className="row wrap">
          {meta.taxonomy.languages.filter((l) => l.key !== p.primaryLanguage).map((l) => (
            <button key={l.key} type="button" className={clsx('chip', p.extraLanguages.includes(l.key as Lang) && 'on')}
              onClick={() => patch({ extraLanguages: toggle(p.extraLanguages, l.key) as Lang[] })}>{LANG_NAMES[l.key as Lang]}</button>
          ))}
        </div>
      </Field>

      <div className="grid two">
        <Field label="Level">
          <Seg ariaLabel="Level" value={p.level} onChange={(level) => patch({ level })} options={LEVELS.map((l) => ({ value: l.key, label: l.name }))} />
        </Field>
        <Field label="Goal">
          <Seg ariaLabel="Goal" value={p.goal} onChange={(goal) => patch({ goal })} options={GOALS.map((g) => ({ value: g.key, label: g.name, tip: g.blurb }))} />
        </Field>
      </div>

      <Field label="Staff archetype" hint="From Will Larson's Staff Engineer. Shapes the coach's advice.">
        <div className="grid four">
          {meta.taxonomy.archetypes.map((a) => (
            <button key={a.key} type="button" className={clsx('preset', p.archetype === a.key && 'on')} onClick={() => patch({ archetype: p.archetype === a.key ? '' : a.key })}>
              <strong>{a.name}</strong><span>{a.blurb}</span>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Primary focus: where you want to hone the hardest" hint="Weighted twice as heavily as anything else and marked ★ on your star plot.">
        <div className="row wrap">
          {meta.taxonomy.domains.map((d) => (
            <button key={d.key} type="button" className={clsx('chip', p.primaryFocus === d.key && 'on')} data-tip={d.blurb}
              onClick={() => patch({ primaryFocus: p.primaryFocus === d.key ? '' : d.key })}>
              {p.primaryFocus === d.key && <span className="star">★</span>}{d.name}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Focal points: areas to add attention to" hint="Weighted up in every regiment and marked ● on your star plot.">
        <div className="row wrap">
          {meta.taxonomy.domains.map((d) => (
            <button key={d.key} type="button" className={clsx('chip', p.focalDomains.includes(d.key) && 'on')} data-tip={d.blurb}
              onClick={() => patch({ focalDomains: toggle(p.focalDomains, d.key) })}>
              {p.focalDomains.includes(d.key) && <span className="star">●</span>}{d.name}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid two">
        <Field label="Your stack" htmlFor="pstack" hint="AI-written scenarios use it as material.">
          <textarea id="pstack" className="textarea" style={{ minHeight: 90 }} value={p.stack} placeholder="Postgres, Kafka, Kubernetes on AWS, Go services, a React front end…" onChange={(e) => patch({ stack: e.target.value })} />
        </Field>
        <Field label="Anything else the coach should know" htmlFor="pctx" hint="Your domain, team shape, what you are working on, what you want to avoid.">
          <textarea id="pctx" className="textarea" style={{ minHeight: 90 }} value={p.context} placeholder="I lead platform work for a 40-engineer org; deep in infra, rusty on front-end and product work…" onChange={(e) => patch({ context: e.target.value })} />
        </Field>
      </div>
      <div className="row end">
        <button type="button" className="btn primary lg" disabled={busy} onClick={save}>{onboarding ? 'Save and see my briefing' : 'Save profile'}</button>
      </div>
    </div>
  );
}
