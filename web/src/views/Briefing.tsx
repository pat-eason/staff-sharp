import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api';
import StarPlot from '../components/StarPlot';
import { Lcd, Meter, pct, Spinner, useAction } from '../components/ui';
import { domainName, keys, useInsight, useMeta, useProfile, useRegiments, useStats } from '../hooks';
import type { Regiment } from '../types';
import { PRESETS } from './Builder';
import { starData } from './Profile';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Briefing() {
  const meta = useMeta().data;
  const profile = useProfile();
  const stats = useStats().data;
  const insight = useInsight().data;
  const regiments = useRegiments().data;
  const nav = useNavigate();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  if (profile.data && !profile.data.onboarded) return <Navigate to="/welcome" replace />;
  if (!meta || !profile.data || !stats) return <div className="empty"><Spinner /></div>;

  const active = (regiments ?? []).filter((r) => r.status === 'active');
  const recent = (regiments ?? []).filter((r) => r.status === 'completed').slice(0, 5);
  const quick = (key: string) => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    run(async () => {
      const r = await api.createRegiment(p.name, '', { ...p.config, preset: p.key, adaptive: true });
      await qc.invalidateQueries({ queryKey: keys.regiments });
      nav(`/sessions/${r.sessions[0].id}`);
    });
  };
  const tuned = () =>
    run(async () => {
      const rec = await api.recommend();
      const r = await api.createRegiment(rec.name, rec.description, rec.config);
      await qc.invalidateQueries({ queryKey: keys.regiments });
      nav(`/regiments/${r.id}`);
    });
  const { axes, series } = starData(stats);

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <div className="eyebrow">Briefing</div>
          <h1>{greeting()}{profile.data.displayName ? `, ${profile.data.displayName}` : ''}.</h1>
          <p className="lede">{insight?.summary ?? 'Your sharpness at a glance, and what to work on next.'}</p>
        </div>
        <div className="row wrap">
          <button type="button" className="btn primary lg" disabled={busy} onClick={tuned}>Build my next regiment</button>
          <Link to="/regiments/new" className="btn light lg">Custom</Link>
        </div>
      </div>

      <div className="briefing-top">
        <div className="glass">
          <StarPlot compact axes={axes} series={series} title="Mastery by domain" />
        </div>
        <div className="stack">
          <div className="glass row wrap" style={{ justifyContent: 'space-between' }}>
            <Lcd label="Accuracy" value={pct(stats.accuracy)} unit="%" big />
            <Lcd label="Potential" value={pct(stats.potential)} unit="%" big />
            <Lcd label="Streak" value={stats.streakDays} unit="d" big />
            <Lcd label="Answered" value={stats.answered} big />
          </div>
          {insight?.focusNext && insight.focusNext.length > 0 && (
            <div className="porcelain stack sm">
              <span className="eyebrow">Focus next</span>
              {insight.focusNext.map((f, i) => (
                <div key={i} className="focus-area">
                  <strong>{domainName(meta, f.domain)}</strong>
                  <span className="small muted">{f.why}</span>
                </div>
              ))}
              <Link to="/profile" className="small">Full profile →</Link>
            </div>
          )}
        </div>
      </div>

      {active.length > 0 && (
        <section className="stack">
          <h2>In progress</h2>
          <div className="grid two">
            {active.map((r) => <ActiveCard key={r.id} r={r} />)}
          </div>
        </section>
      )}

      <section className="stack">
        <h2>Quick start</h2>
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" className="preset" disabled={busy} onClick={() => quick(p.key)}>
              <strong>{p.name}</strong><span>{p.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      {recent.length > 0 && (
        <section className="stack">
          <h2>Recent results</h2>
          <div className="glass flush">
            {recent.map((r) => (
              <Link key={r.id} to={`/regiments/${r.id}`} className="list-row">
                <span className="grow"><strong>{r.name}</strong><br /><span className="small faint">{new Date(r.completedAt ?? r.createdAt).toLocaleDateString()}</span></span>
                <span className="mono">{pct(r.accuracy)}%</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ActiveCard({ r }: { r: Regiment }) {
  const next = r.sessions.find((s) => s.status !== 'completed');
  const total = r.sessions.length;
  return (
    <div className="glass stack">
      <div className="row between">
        <div className="grow">
          <Link to={`/regiments/${r.id}`} className="card-title">{r.name}</Link>
          <div className="small faint">Day {next?.dayIndex ?? total} of {total}{r.config.timed ? ' · timed' : ''}</div>
        </div>
        {r.accuracy != null && <span className="mono">{pct(r.accuracy)}%</span>}
      </div>
      <Meter value={r.daysCompleted / total} accent label="Days completed" />
      <div className="row between">
        <div className="row" style={{ gap: 4 }}>
          {r.sessions.slice(0, 14).map((s) => <span key={s.id} className={clsx('mini-bead', s.status)} />)}
          {total > 14 && <span className="faint small">+{total - 14}</span>}
        </div>
        {next && (
          <Link className="btn primary sm" to={`/sessions/${next.id}`}>{next.status === 'in_progress' ? 'Continue' : 'Start'} day {next.dayIndex}</Link>
        )}
      </div>
    </div>
  );
}
