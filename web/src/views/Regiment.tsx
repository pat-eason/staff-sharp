import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useDialog } from '../components/Overlay';
import { Lcd, Meter, pct, Spinner, useAction } from '../components/ui';
import { domainName, keys, useMeta, useRegiment } from '../hooks';
import type { Breakdown, Meta, Recommendation, Regiment, Report } from '../types';
import { DIFFICULTY_NAMES } from '../types';
import { formatMs } from '../format';

export default function RegimentPage() {
  const { id = '' } = useParams();
  const { data: r, isLoading, error } = useRegiment(id);
  const meta = useMeta().data;
  const nav = useNavigate();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const { confirm } = useDialog();
  if (isLoading) return <div className="empty"><Spinner /></div>;
  if (error || !r) return <div className="empty">Regiment not found. <Link to="/regiments">All regiments</Link></div>;

  const next = r.sessions.find((s) => s.status !== 'completed');
  const remove = async () => {
    if (!(await confirm({ title: `Delete “${r.name}”?`, body: 'All of its days and answers are removed. This cannot be undone.', confirmLabel: 'Delete regiment', danger: true }))) return;
    run(async () => {
      await api.deleteRegiment(r.id);
      await qc.invalidateQueries({ queryKey: keys.regiments });
      nav('/regiments');
    }, 'Regiment deleted');
  };

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <div className="eyebrow">{r.status === 'completed' ? 'Completed regiment' : 'Active regiment'}</div>
          <h1>{r.name}</h1>
          <p className="lede">{r.description || configSummary(r, meta)}</p>
        </div>
        <div className="row wrap">
          {next && (
            <Link className="btn primary lg" to={`/sessions/${next.id}`}>
              {next.status === 'in_progress' ? `Continue day ${next.dayIndex}` : `Start day ${next.dayIndex}`}
            </Link>
          )}
          <button type="button" className="btn ghost" onClick={remove} disabled={busy}>Delete</button>
        </div>
      </div>

      <div className="glass">
        <div className="days">
          {r.sessions.map((s) => (
            <Link key={s.id} to={`/sessions/${s.id}`} className={clsx('day', s.status)} aria-label={`Day ${s.dayIndex}: ${s.status.replace('_', ' ')}`}>
              <span className="day-bead">{s.status === 'completed' ? pct(s.accuracy) : s.dayIndex}</span>
              <span className="day-label">Day {s.dayIndex}</span>
              <span className="day-sub">{s.status === 'completed' ? `${s.answered}/${s.itemCount}` : s.status === 'in_progress' ? 'in progress' : s.scheduledFor?.slice(5) ?? ''}</span>
            </Link>
          ))}
        </div>
      </div>

      {r.report && r.report.answered + r.report.skipped > 0 ? (
        <ReportView r={r} report={r.report} meta={meta} />
      ) : (
        <div className="glass empty">Finish a day to see the report.</div>
      )}
    </div>
  );
}

function configSummary(r: Regiment, meta?: Meta): string {
  const c = r.config;
  const doms = c.domains?.length ? c.domains.map((d) => domainName(meta, d)).join(', ') : 'all domains';
  return `${c.days} day${c.days > 1 ? 's' : ''} × ${c.perDay} · ${doms} · ${DIFFICULTY_NAMES[c.difficultyMin]}–${DIFFICULTY_NAMES[c.difficultyMax]}${c.timed ? ' · timed' : ''}`;
}

function Bars({ title, rows }: { title: string; rows: Breakdown[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="stack sm">
      <span className="eyebrow">{title}</span>
      {rows.map((b) => (
        <div key={b.key} className="bar-row">
          <span className="bar-name">{b.name}</span>
          <div className="grow stack" style={{ gap: 3 }}>
            <Meter value={b.accuracy} label={`${b.name} accuracy`} />
            <Meter value={b.potential} accent label={`${b.name} potential`} />
          </div>
          <span className="bar-val mono">{pct(b.accuracy)}<small className="faint">/{pct(b.potential)}</small></span>
          <span className="faint small">n={b.count}</span>
        </div>
      ))}
    </div>
  );
}

function ReportView({ r, report, meta }: { r: Regiment; report: Report; meta?: Meta }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { run, busy } = useAction();
  const coach: Recommendation = r.debriefStatus === 'ready' && r.debrief ? r.debrief : report.recommendation;
  const startNext = () => {
    const nx = coach.next ?? report.recommendation.next;
    if (!nx) return;
    run(async () => {
      const created = await api.createRegiment(nx.name, nx.description, nx.config);
      await qc.invalidateQueries({ queryKey: keys.regiments });
      nav(`/regiments/${created.id}`);
    });
  };
  const redebrief = () => run(async () => qc.setQueryData(keys.regiment(r.id), await api.redebrief(r.id)));

  return (
    <div className="stack lg">
      <div className="grid two">
        <div className="glass stack">
          <span className="eyebrow">Grade</span>
          <div className="row wrap">
            <Lcd label="Accuracy" value={pct(report.accuracy)} unit="%" big />
            <Lcd label="Potential" value={pct(report.potential)} unit="%" big />
          </div>
          <h2>{report.band}</h2>
          <p className="muted small" style={{ margin: 0 }}>
            <strong>Accuracy</strong> is how right you were. <strong>Potential</strong> weighs the quality of reasoning and how well your
            confidence matched reality: a hedged miss scores higher than a confident one.
          </p>
          <div className="row wrap small muted">
            <span>{report.answered} answered</span>
            {report.skipped > 0 && <span>· {report.skipped} skipped</span>}
            <span>· {formatMs(report.timeMs)} on the clock (estimate {formatMs(report.estMs)})</span>
            {report.focusLosses > 0 && <span>· left the tab {report.focusLosses}×</span>}
            {report.pendingGrades > 0 && <span className="row" style={{ gap: 6 }}><Spinner label="Grading" /> {report.pendingGrades} still grading</span>}
          </div>
        </div>

        <div className="porcelain stack">
          <div className="row between wrap">
            <span className="eyebrow">Direction</span>
            <span className="row small">
              {r.debriefStatus === 'pending' && <><Spinner label="Coaching" /> <span className="muted">The coach is writing…</span></>}
              {r.debriefStatus === 'ready' && <span className="tag accent">AI coach</span>}
              {r.debriefStatus !== 'ready' && r.debriefStatus !== 'pending' && <span className="tag">Rules</span>}
              {r.status === 'completed' && meta?.llm.active && r.debriefStatus !== 'pending' && (
                <button type="button" className="btn sm ghost" disabled={busy} onClick={redebrief}>{r.debriefStatus === 'ready' ? 'Rewrite' : 'Ask the coach'}</button>
              )}
            </span>
          </div>
          <h2>{coach.headline}</h2>
          <p>{coach.direction}</p>
          {r.debriefStatus === 'failed' && r.debriefError && <p className="small muted">Coach failed: {r.debriefError}</p>}
          {coach.focusAreas?.length > 0 && (
            <div className="stack sm">
              {coach.focusAreas.map((f, i) => (
                <div key={i} className="focus-area">
                  <strong>{domainName(meta, f.domain)}{f.concept ? ` · ${f.concept.replace(/-/g, ' ')}` : ''}</strong>
                  <span className="muted small">{f.why}</span>
                  {f.practice && <span className="small">→ {f.practice}</span>}
                </div>
              ))}
            </div>
          )}
          {coach.strengths && coach.strengths.length > 0 && <p className="small"><strong>Strengths:</strong> {coach.strengths.join(', ')}</p>}
          {(coach.next ?? report.recommendation.next) && (
            <div className="next-up">
              <div className="grow">
                <span className="eyebrow">Suggested next</span>
                <strong>{(coach.next ?? report.recommendation.next)?.name}</strong>
              </div>
              <button type="button" className="btn primary" onClick={startNext} disabled={busy}>Build this regiment</button>
            </div>
          )}
        </div>
      </div>

      <div className="grid two">
        <div className="glass stack lg">
          <Bars title="By domain" rows={report.byDomain} />
          <Bars title="By skill" rows={report.bySkill} />
        </div>
        <div className="glass stack lg">
          <Bars title="By question type" rows={report.byType} />
          {report.byDay.length > 1 && <Bars title="By day" rows={report.byDay} />}
          {report.blindSpots && report.blindSpots.length > 0 && (
            <div className="stack sm">
              <span className="eyebrow">Blind spots: certain, and wrong</span>
              {report.blindSpots.map((b) => <div key={b.questionId} className="small">● {b.title} <span className="faint">({domainName(meta, b.domain)})</span></div>)}
            </div>
          )}
          {report.weakConcepts && report.weakConcepts.length > 0 && (
            <div className="stack sm">
              <span className="eyebrow">Weakest concepts</span>
              <div className="row wrap">
                {report.weakConcepts.map((c) => <span key={c.domain + c.concept} className="tag">{c.concept.replace(/-/g, ' ')} · {pct(c.accuracy)}%</span>)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
