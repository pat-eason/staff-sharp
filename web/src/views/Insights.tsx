import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Spark, TrendChart, VolumeBars } from '../components/charts';
import { Lcd, Markdown, pct, Pips, Seg, Spinner, useAction } from '../components/ui';
import { formatMs } from '../format';
import { domainName, keys, typeName, useMeta } from '../hooks';
import type { History, Meta } from '../types';

type Tab = 'trends' | 'coach' | 'ledger';

/** Historic insights from the answer ledger: trends, saved coach summaries, debriefs and every answer. */
export default function Insights() {
  const meta = useMeta().data;
  const { data: h, isLoading, error } = useQuery({ queryKey: ['history'], queryFn: api.history });
  const [tab, setTab] = useState<Tab>('trends');
  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <div className="eyebrow">Insights</div>
          <h1>The ledger</h1>
          <p className="lede">Every answer you have given, how your edge has moved week to week, and what the coach said along the way.</p>
        </div>
        <Seg<Tab> ariaLabel="Insights view" value={tab} onChange={setTab}
          options={[{ value: 'trends', label: 'Trends' }, { value: 'coach', label: 'Coach history' }, { value: 'ledger', label: 'Ledger' }]} />
      </div>
      {isLoading ? <div className="empty"><Spinner /></div> : error || !h ? (
        <div className="glass empty">Could not load your history: {(error as Error)?.message}</div>
      ) : h.answered === 0 ? (
        <div className="glass empty stack" style={{ alignItems: 'center' }}>
          <p>No answers in the ledger yet.</p>
          <Link to="/regiments/new" className="btn primary">Start a regiment</Link>
        </div>
      ) : (
        <>
          {tab === 'trends' && <Trends h={h} meta={meta} />}
          {tab === 'coach' && <CoachHistory h={h} meta={meta} />}
          {tab === 'ledger' && <Ledger meta={meta} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- trends

function Trends({ h, meta }: { h: History; meta?: Meta }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const [asTable, setAsTable] = useState(false);
  const labels = h.weeks.map((w) => w.week);
  const active = h.weeks.filter((w) => w.answered > 0);
  const recent = active.slice(-4);
  const earlier = active.slice(0, Math.max(0, active.length - 4));
  const mean = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const recentAcc = mean(recent.map((w) => w.accuracy));
  const earlierAcc = mean(earlier.map((w) => w.accuracy));
  const delta = recentAcc != null && earlierAcc != null ? recentAcc - earlierAcc : null;
  const movers = useMemo(() => h.domains.filter((d) => d.change != null).sort((a, b) => (b.change ?? 0) - (a.change ?? 0)), [h.domains]);
  const drill = (ids: string[], name: string) =>
    run(async () => {
      const r = await api.createRegiment(name, 'Questions you have missed more than once.', { questionIds: ids, perDay: ids.length, days: 1, feedback: 'immediate', difficultyMin: 1, difficultyMax: 5 });
      await qc.invalidateQueries({ queryKey: keys.regiments });
      nav(`/sessions/${r.sessions[0].id}`);
    });

  return (
    <div className="stack lg">
      <div className="glass row wrap" style={{ justifyContent: 'space-between' }}>
        <Lcd label="Answers" value={h.answered} big />
        <Lcd label="Active weeks" value={active.length} big />
        <Lcd label="Last 4 wks" value={pct(recentAcc)} unit="%" big />
        <Lcd label="vs before" value={delta == null ? '—' : `${delta >= 0 ? '+' : '−'}${Math.abs(Math.round(delta * 100))}`} unit={delta == null ? '' : 'pt'} big hot={delta != null && delta < -0.05} />
        <Lcd label="Blind spots" value={h.weeks.reduce((a, w) => a + w.blindSpots, 0)} big />
      </div>

      <div className="glass stack">
        <div className="row between wrap">
          <div>
            <h3>Accuracy and potential by week</h3>
            <span className="hint">Breaks in a line are weeks with no answers.</span>
          </div>
          <div className="row">
            <div className="chart-legend">
              <span><i className="swatch tone-a" />Accuracy</span>
              <span><i className="swatch tone-b" />Potential</span>
            </div>
            <button type="button" className="btn sm ghost" onClick={() => setAsTable((t) => !t)}>{asTable ? 'Show chart' : 'Show table'}</button>
          </div>
        </div>
        {asTable ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Week of</th><th>Answers</th><th>Accuracy</th><th>Potential</th><th>Minutes</th><th>Blind spots</th></tr></thead>
              <tbody>
                {[...h.weeks].reverse().map((w) => (
                  <tr key={w.week}><td>{w.week}</td><td>{w.answered}</td><td>{pct(w.accuracy)}%</td><td>{pct(w.potential)}%</td><td>{w.minutes}</td><td>{w.blindSpots}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <TrendChart labels={labels} series={[
            { key: 'acc', name: 'Accuracy', tone: 'a', values: h.weeks.map((w) => w.accuracy) },
            { key: 'pot', name: 'Potential', tone: 'b', values: h.weeks.map((w) => w.potential) },
          ]} />
        )}
        {!asTable && (
          <>
            <h4 style={{ marginTop: 6 }}>Answers per week</h4>
            <VolumeBars labels={labels} values={h.weeks.map((w) => w.answered)} unit="answers" />
          </>
        )}
      </div>

      <div className="glass stack">
        <div className="row between wrap">
          <h3>Mastery trajectory by domain</h3>
          <span className="hint">Mastery at the end of each week. The change compares today with 30 days ago.</span>
        </div>
        <div className="sparks">
          {h.domains.map((d) => (
            <div key={d.key} className={clsx('spark-card', d.count === 0 && 'empty')}>
              <div className="row between">
                <strong className="small">{d.name}</strong>
                <span className="mono small">{d.count ? `${pct(d.now)}%` : '—'}</span>
              </div>
              <Spark values={d.mastery} label={`${d.name} mastery by week`} />
              <span className="tiny faint">
                {d.count === 0 ? 'No answers yet' : `${d.count} answers`}
                {d.change != null && <> · {d.change >= 0 ? '▲' : '▼'} {Math.abs(Math.round(d.change * 100))} pt in 30 days</>}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid two">
        <div className="glass stack sm">
          <h3>Biggest movers</h3>
          {movers.length === 0 ? <p className="muted small">Needs answers from more than 30 days ago to compare against.</p> : (
            <>
              {movers.slice(0, 3).map((d) => <div key={d.key} className="row between small"><span>▲ {d.name}</span><span className="mono">+{Math.round((d.change ?? 0) * 100)} pt</span></div>)}
              {movers.length > 3 && <hr className="divider" />}
              {movers.slice(-3).filter((d) => (d.change ?? 0) < 0).reverse().map((d) => <div key={d.key} className="row between small"><span>▼ {d.name}</span><span className="mono">−{Math.abs(Math.round((d.change ?? 0) * 100))} pt</span></div>)}
            </>
          )}
        </div>
        <div className="glass stack sm">
          <div className="row between wrap">
            <h3>Recurring misses</h3>
            {h.recurring.length > 0 && (
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => drill(h.recurring.map((r) => r.questionId), 'Recurring misses')}>Drill all</button>
            )}
          </div>
          {h.recurring.length === 0 ? <p className="muted small">Nothing you have missed more than once. Questions come back for a second try a few days after a miss.</p> : (
            h.recurring.map((r) => (
              <div key={r.questionId} className="row between small">
                <span className="grow">{r.title} <span className="faint">· {domainName(meta, r.domain)}</span></span>
                <span className="mono faint">{r.attempts}× · avg {pct(r.average)}%</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- coach history

function CoachHistory({ h, meta }: { h: History; meta?: Meta }) {
  // Interleave saved profile summaries and regiment debriefs into one timeline, newest first.
  const entries = useMemo(() => {
    const out: ({ kind: 'insight'; at: string; i: number } | { kind: 'debrief'; at: string; i: number })[] = [];
    h.insights.forEach((x, i) => out.push({ kind: 'insight', at: x.createdAt, i }));
    h.debriefs.forEach((x, i) => out.push({ kind: 'debrief', at: x.completedAt, i }));
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [h]);
  if (entries.length === 0) return <div className="glass empty">Finish a regiment or refresh your profile summary to start the coach history.</div>;
  return (
    <ol className="timeline">
      {entries.map((e) => {
        const when = new Date(e.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        if (e.kind === 'debrief') {
          const d = h.debriefs[e.i];
          return (
            <li key={`d-${d.regimentId}`} className="timeline-item">
              <span className="timeline-dot debrief" aria-hidden />
              <div className="porcelain stack sm">
                <div className="row between wrap">
                  <span className="eyebrow">Regiment debrief · {when}</span>
                  <span className="row">
                    <span className={clsx('tag', d.source === 'llm' && 'accent')}>{d.source === 'llm' ? 'AI coach' : 'Rules'}</span>
                    {d.accuracy != null && <span className="mono small">{pct(d.accuracy)}% / {pct(d.potential)}%</span>}
                  </span>
                </div>
                <Link to={`/regiments/${d.regimentId}`} className="card-title" style={{ color: 'inherit' }}>{d.name}</Link>
                <strong>{d.headline}</strong>
                {d.direction && <p className="small muted" style={{ margin: 0 }}>{d.direction}</p>}
              </div>
            </li>
          );
        }
        const x = h.insights[e.i];
        return (
          <li key={`i-${x.createdAt}-${e.i}`} className="timeline-item">
            <span className="timeline-dot" aria-hidden />
            <div className="glass stack sm">
              <div className="row between wrap">
                <span className="eyebrow">Profile summary · {when}</span>
                <span className={clsx('tag', x.source === 'llm' && 'accent')}>{x.source === 'llm' ? 'AI coach' : 'Rules'}</span>
              </div>
              <Markdown className="small">{x.summary}</Markdown>
              {x.focusNext && x.focusNext.length > 0 && (
                <div className="row wrap">{x.focusNext.map((f) => <span key={f.domain} className="tag">Focus: {domainName(meta, f.domain)}</span>)}</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- ledger

const PAGE = 50;

function Ledger({ meta }: { meta?: Meta }) {
  const [domain, setDomain] = useState('');
  const [type, setType] = useState('');
  const [result, setResult] = useState('');
  const [offset, setOffset] = useState(0);
  const filters: Record<string, string> = { limit: String(PAGE), offset: String(offset) };
  if (domain) filters.domain = domain;
  if (type) filters.type = type;
  if (result) filters.result = result;
  const { data, isLoading, error } = useQuery({ queryKey: ['ledger', filters], queryFn: () => api.ledger(filters) });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0); };

  return (
    <div className="stack">
      <div className="glass row wrap">
        <select className="select" style={{ maxWidth: 260 }} aria-label="Domain" value={domain} onChange={(e) => reset(setDomain)(e.target.value)}>
          <option value="">All domains</option>
          {meta?.taxonomy.domains.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
        </select>
        <select className="select" style={{ maxWidth: 200 }} aria-label="Type" value={type} onChange={(e) => reset(setType)(e.target.value)}>
          <option value="">All types</option>
          {meta?.taxonomy.types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
        </select>
        <Seg ariaLabel="Result" value={result} onChange={reset(setResult)}
          options={[{ value: '', label: 'All' }, { value: 'correct', label: 'Correct' }, { value: 'partial', label: 'Partial' }, { value: 'missed', label: 'Missed' }, { value: 'blind', label: 'Blind spots' }, { value: 'skipped', label: 'Skipped' }]} />
        <span className="faint small">{data ? `${data.total} answers` : ''}</span>
      </div>
      {isLoading ? <div className="empty"><Spinner /></div> : error || !data ? (
        <div className="glass empty">Could not load the ledger: {(error as Error)?.message}</div>
      ) : data.rows.length === 0 ? (
        <div className="glass empty">No answers match.</div>
      ) : (
        <div className="glass flush table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>When</th><th>Question</th><th>Domain</th><th>Type</th><th>Level</th><th>Score</th><th>Confidence</th><th>Time</th><th /></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.itemId}>
                  <td className="nowrap faint">{new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                  <td><strong>{r.title}</strong><br /><span className="tiny faint">{r.regimentName} · day {r.dayIndex}</span></td>
                  <td className="small">{domainName(meta, r.domain)}</td>
                  <td className="small">{typeName(meta, r.type)}</td>
                  <td><Pips n={r.difficulty} /></td>
                  <td className="nowrap">
                    <span className={clsx('tag', r.skipped ? 'bad' : r.score >= 0.7 ? 'good' : r.score >= 0.4 ? 'mid' : 'bad')}>
                      {r.skipped ? 'skipped' : `${pct(r.score)}%`}
                    </span>
                  </td>
                  <td className="small faint">{r.confidence ? ['', 'guess', 'fairly sure', 'certain'][r.confidence] : '—'}</td>
                  <td className="small faint mono">{r.timeMs ? formatMs(r.timeMs) : '—'}</td>
                  <td><Link className="btn sm ghost" to={`/sessions/${r.sessionId}`}>Review</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > PAGE && (
        <div className="row between">
          <button type="button" className="btn sm ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Newer</button>
          <span className="small faint">{offset + 1}–{Math.min(data.total, offset + PAGE)} of {data.total}</span>
          <button type="button" className="btn sm ghost" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Older →</button>
        </div>
      )}
    </div>
  );
}
