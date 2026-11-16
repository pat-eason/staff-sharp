import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import AnswerInput from '../components/AnswerInput';
import Feedback from '../components/Feedback';
import { LANG_NAMES } from '../components/highlight';
import { useDialog } from '../components/Overlay';
import { Lcd, Markdown, pct, Pips, Seg, Spinner, useAction } from '../components/ui';
import Watch from '../components/Watch';
import { domainName, keys, typeName, useMeta, useSession } from '../hooks';
import type { Item, Meta, PublicQuestion, Response, Session } from '../types';
import { DIFFICULTY_NAMES } from '../types';
import { formatMs } from '../format';

type Draft = { response: Response; confidence: number | null };

function isAnswerable(q: PublicQuestion, r: Response): boolean {
  switch (q.type) {
    case 'mcq':
    case 'multi':
      return (r.selected?.length ?? 0) > 0;
    case 'numeric':
      return r.value != null && r.value > 0;
    case 'ordering':
      return true;
    case 'free_text':
      return (r.text?.trim().length ?? 0) > 10;
    case 'diagram':
      return (r.diagram?.nodes.length ?? 0) > 0 || (r.text?.trim().length ?? 0) > 10;
    case 'code_review':
    case 'bug_hunt':
      return (r.comments?.length ?? 0) > 0 || (r.text?.trim().length ?? 0) > 10;
  }
}

function initialDraft(item: Item): Draft {
  const q = item.question;
  if (q?.type === 'ordering') return { response: { order: (q.items ?? []).map((i) => i.id) }, confidence: null };
  return { response: {}, confidence: null };
}

export default function SessionPage() {
  const { id = '' } = useParams();
  const { data: session, isLoading, error, dataUpdatedAt } = useSession(id);
  const meta = useMeta().data;
  if (isLoading) return <div className="empty"><Spinner /></div>;
  if (error || !session) return <div className="empty">Could not load this day. <Link to="/">Back to the briefing</Link></div>;
  if (session.status === 'pending') return <StartDay session={session} />;
  if (session.status === 'completed') return <Review session={session} meta={meta} />;
  return <Runner session={session} meta={meta} syncedAt={performance.now() - (Date.now() - dataUpdatedAt)} />;
}

// ---------------------------------------------------------------- start

function StartDay({ session }: { session: Session }) {
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const start = () => run(async () => qc.setQueryData(keys.session(session.id), await api.startSession(session.id)));
  return (
    <div className="stack lg" style={{ maxWidth: 720 }}>
      <div>
        <div className="eyebrow">{session.regimentName}</div>
        <h1>Day {session.dayIndex} of {session.days}</h1>
      </div>
      <div className="porcelain stack">
        <h2>Ready when you are</h2>
        <p className="muted">
          Today's questions are picked when you start, weighted toward your focal points and the areas your earlier results
          say need work.
          {session.timed
            ? ' This is a timed set: the chronograph starts with the day. Press either pusher to pause; the questions are hidden while it is stopped.'
            : ' This set is untimed. Take the time you need.'}
        </p>
        <p className="muted small">
          Feedback: {session.feedback === 'immediate' ? 'after every answer.' : 'at the end of the day.'} Confidence is optional, but
          answering “certain” on a miss flags a blind spot, which is the most useful signal this tool gives you.
        </p>
        <div className="row"><button type="button" className="btn primary lg" disabled={busy} onClick={start}>{busy ? 'Picking questions…' : 'Start the day'}</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- runner

function Runner({ session, meta, syncedAt }: { session: Session; meta?: Meta; syncedAt: number }) {
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const [pos, setPos] = useState(() => {
    const open = session.items.findIndex((i) => i.status === 'open');
    return open >= 0 ? open : 0;
  });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const itemClock = useRef<{ id: string; since: number; spent: Record<string, number> }>({ id: '', since: performance.now(), spent: {} });
  const finishing = useRef(false);
  const item = session.items[Math.min(pos, session.items.length - 1)];
  const paused = session.timed && !session.running;
  const set = (s: Session) => qc.setQueryData(keys.session(session.id), s);

  // Per-item time: accumulate while the item is on screen and the watch runs.
  useEffect(() => {
    const clock = itemClock.current;
    const now = performance.now();
    if (clock.id && session.running) clock.spent[clock.id] = (clock.spent[clock.id] ?? 0) + (now - clock.since);
    clock.id = item?.id ?? '';
    clock.since = now;
  }, [item?.id, session.running]);

  // Leaving the tab during a running timed set is recorded (shown in the report as an integrity note).
  useEffect(() => {
    if (!session.timed) return;
    const onHide = () => {
      if (document.visibilityState === 'hidden' && session.running) api.focusLost(session.id).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [session.id, session.timed, session.running]);

  // When the budget runs out the day finishes itself; unanswered questions count as skipped.
  useEffect(() => {
    if (!session.timed || !session.running || !session.timeLimitSeconds) return;
    const limitMs = session.timeLimitSeconds * 1000;
    const timer = window.setInterval(() => {
      const elapsed = session.elapsedMs + (performance.now() - syncedAt);
      if (elapsed >= limitMs && !finishing.current) {
        finishing.current = true;
        api.finish(session.id).then(set).catch(() => (finishing.current = false));
      }
    }, 500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.timed, session.running, session.timeLimitSeconds, session.elapsedMs, syncedAt]);

  const toggleWatch = () => run(async () => set(session.running ? await api.pause(session.id) : await api.resume(session.id)));

  const draft = (item && drafts[item.id]) ?? (item ? initialDraft(item) : { response: {}, confidence: null });
  const setDraft = (d: Partial<Draft>) => item && setDrafts((all) => ({ ...all, [item.id]: { ...draft, ...d } }));

  const spentFor = (id: string) => {
    const c = itemClock.current;
    const live = c.id === id && session.running ? performance.now() - c.since : 0;
    return Math.round((c.spent[id] ?? 0) + live);
  };

  const submit = () => {
    if (!item?.question) return;
    run(async () => {
      const next = await api.answer(item.id, draft.response, draft.confidence, spentFor(item.id));
      set(next);
      if (session.feedback === 'end') {
        const nextOpen = next.items.findIndex((i, idx) => idx > pos && i.status !== 'submitted' && i.status !== 'skipped');
        const anyOpen = next.items.findIndex((i) => i.status === 'open' || i.status === 'generating');
        if (nextOpen >= 0) setPos(nextOpen);
        else if (anyOpen >= 0) setPos(anyOpen);
      }
    });
  };

  const { confirm } = useDialog();
  const remaining = session.items.filter((i) => i.status === 'open' || i.status === 'generating').length;
  const finish = async () => {
    if (remaining > 0 && !(await confirm({ title: 'Finish the day?', body: `${remaining} question${remaining > 1 ? 's are' : ' is'} unanswered and will count as skipped.`, confirmLabel: 'Finish the day', cancelLabel: 'Keep going' }))) return;
    finishing.current = true;
    run(async () => set(await api.finish(session.id))).finally(() => (finishing.current = false));
  };

  return (
    <div className={clsx('session', session.timed && 'timed')}>
      <div className="session-head">
        <div>
          <div className="eyebrow">{session.regimentName} · Day {session.dayIndex} of {session.days}</div>
          <h2 style={{ marginTop: 6 }}>Question {pos + 1} of {session.items.length}</h2>
        </div>
        <div className="row wrap">
          <Dots session={session} pos={pos} onPick={setPos} />
          <button type="button" className="btn ghost sm" onClick={finish} disabled={busy}>Finish day</button>
        </div>
      </div>

      {item && (
        <div className="porcelain qcard">
          {paused || item.withheld ? (
            <PausedVeil onResume={toggleWatch} busy={busy} />
          ) : item.status === 'generating' ? (
            <div className="empty" style={{ color: 'var(--ink-soft)' }}>
              <Spinner label="Writing" />
              <p style={{ marginTop: 12 }}>Writing a fresh scenario for you… It is usually ready in under a minute; answer the others meanwhile.</p>
            </div>
          ) : item.question ? (
            <>
              <QuestionHeader q={item.question} meta={meta} />
              <AnswerInput
                key={`${item.id}-${item.question.codeLanguage ?? ''}`}
                q={item.question}
                draft={item.status === 'submitted' ? { ...draft.response, ...(item.response ?? {}) } : draft.response}
                setDraft={(response) => setDraft({ response })}
                components={meta?.taxonomy.components ?? []}
                locked={item.status !== 'open'}
                reveal={item.reveal}
                onVariant={(lang) => run(async () => set(await api.setVariant(item.id, lang)))}
              />
              {item.status === 'open' ? (
                <div className="qfoot">
                  <div className="confidence">
                    <span className="label">Confidence</span>
                    <Seg<number> ariaLabel="Confidence" value={draft.confidence ?? 0} onChange={(v) => setDraft({ confidence: v === draft.confidence ? null : v })}
                      options={[{ value: 1, label: 'Guessing' }, { value: 2, label: 'Fairly sure' }, { value: 3, label: 'Certain' }]} />
                  </div>
                  <div className="row">
                    {pos < session.items.length - 1 && (
                      <button type="button" className="btn ghost" onClick={() => setPos(pos + 1)}>Skip for now</button>
                    )}
                    <button type="button" className="btn primary" disabled={busy || !isAnswerable(item.question, draft.response)} onClick={submit}>
                      {busy ? 'Submitting…' : 'Submit answer'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="qfoot">
                  {session.feedback === 'end' ? <span className="muted">Answer saved. Feedback arrives when you finish the day.</span> : <span />}
                  {pos < session.items.length - 1 ? (
                    <button type="button" className="btn light" onClick={() => setPos(pos + 1)}>Next question →</button>
                  ) : remaining === 0 ? (
                    <button type="button" className="btn primary" disabled={busy} onClick={finish}>Finish the day</button>
                  ) : null}
                </div>
              )}
              {item.reveal && item.status !== 'open' && (
                <Feedback item={item} llm={session.llm} busy={busy}
                  onSelfGrade={(covered) => run(async () => set(await api.selfGrade(item.id, covered)), 'Self-grade saved')}
                  onRegrade={() => run(async () => { await api.regrade(item.id); set(await api.session(session.id)); })} />
              )}
            </>
          ) : null}
        </div>
      )}

      {session.timed && (
        <div className="watch-dock">
          <Watch elapsedMs={session.elapsedMs} syncedAt={syncedAt} running={session.running}
            limitSeconds={session.timeLimitSeconds} onToggle={toggleWatch} disabled={busy} />
        </div>
      )}
    </div>
  );
}

function Dots({ session, pos, onPick }: { session: Session; pos: number; onPick: (i: number) => void }) {
  return (
    <nav className="dots" aria-label="Questions">
      {session.items.map((it, i) => {
        const shown = session.feedback === 'immediate' && it.status === 'submitted' ? it.score : null;
        return (
          <button key={it.id} type="button" onClick={() => onPick(i)} aria-current={i === pos ? 'step' : undefined}
            aria-label={`Question ${i + 1}: ${it.status}`}
            className={clsx('dot', i === pos && 'current', it.status === 'submitted' && 'done', it.status === 'skipped' && 'skipped',
              it.status === 'generating' && 'gen', scoreTone(shown))}>
            {i + 1}
          </button>
        );
      })}
    </nav>
  );
}

export function QuestionHeader({ q, meta }: { q: PublicQuestion; meta?: Meta }) {
  return (
    <>
      <div className="qmeta">
        <span className="tag">{domainName(meta, q.domain)}</span>
        <span className="tag">{typeName(meta, q.type)}</span>
        {q.codeLanguage && <span className="tag">{LANG_NAMES[q.codeLanguage]}</span>}
        {q.source === 'generated' && <span className="tag accent">Fresh scenario</span>}
        <span className="row small muted" style={{ gap: 6 }}>
          <Pips n={q.difficulty} /> {DIFFICULTY_NAMES[q.difficulty]}
        </span>
        <span className="small faint">~{Math.max(1, Math.round(q.estSeconds / 60))} min</span>
      </div>
      <h3 className="qtitle">{q.title}</h3>
      <Markdown className="qprompt">{q.prompt}</Markdown>
      {q.context && (
        <div className="inset qcontext">
          <span className="eyebrow">Evidence</span>
          <Markdown>{q.context}</Markdown>
        </div>
      )}
    </>
  );
}

const GLYPHS = '▓▒░█▚▞▙▟▛▜▖▗▘▝';

/** Shown while the watch is stopped. The server sent no question text, so there is nothing here to read. */
function PausedVeil({ onResume, busy }: { onResume: () => void; busy: boolean }) {
  const noise = useMemo(() => Array.from({ length: 420 }, (_, i) => GLYPHS[(i * 7919) % GLYPHS.length]).join(''), []);
  return (
    <div className="scramble" aria-live="polite">
      <div className="scramble-line title" />
      <div className="scramble-glyphs" aria-hidden>{noise}</div>
      {[92, 84, 96, 70, 88, 60].map((w, i) => <div key={i} className="scramble-line" style={{ width: `${w}%` }} />)}
      <div className="paused-veil">
        <div className="stack" style={{ alignItems: 'center' }}>
          <span className="eyebrow">Chronograph stopped</span>
          <h3>Paused</h3>
          <p className="muted" style={{ maxWidth: 340 }}>The question is hidden until the watch runs again. Press a pusher on the watch, or:</p>
          <button type="button" className="btn primary" onClick={onResume} disabled={busy}>Resume</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- review

function Review({ session, meta }: { session: Session; meta?: Meta }) {
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const scored = session.items.filter((i) => i.score != null && i.question);
  const acc = scored.length ? scored.reduce((a, i) => a + (i.score ?? 0), 0) / scored.length : 0;
  const pot = scored.length ? scored.reduce((a, i) => a + (i.potential ?? i.score ?? 0), 0) / scored.length : 0;
  const pending = session.items.some((i) => i.gradeStatus === 'pending');
  const set = (s: Session) => qc.setQueryData(keys.session(session.id), s);
  const [open, setOpen] = useState<string | null>(session.items[0]?.id ?? null);

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <div className="eyebrow">{session.regimentName} · Day {session.dayIndex} of {session.days} · complete</div>
          <h1>Day review</h1>
          <p className="lede">{pending ? 'The model is still grading some written answers; scores update as they land.' : 'Every answer with its key, the grader’s notes and the takeaway.'}</p>
        </div>
        <div className="row wrap">
          <Lcd label="Accuracy" value={pct(acc)} unit="%" big />
          <Lcd label="Potential" value={pct(pot)} unit="%" big />
          <Lcd label="Time" value={formatMs(session.elapsedMs)} />
          {session.focusLosses > 0 && <Lcd label="Tab switches" value={session.focusLosses} hot />}
        </div>
      </div>
      <div className="row">
        {session.preset === 'calibration' ? (
          <Link className="btn primary lg" to="/welcome?step=result">Calibration done: see your level →</Link>
        ) : (
          <Link className="btn primary" to={`/regiments/${session.regimentId}`}>Regiment report →</Link>
        )}
      </div>
      <div className="stack">
        {session.items.map((item, i) => {
          if (!item.question) return null;
          const expanded = open === item.id;
          return (
            <div key={item.id} className="porcelain qcard" style={{ padding: expanded ? 26 : '16px 22px' }}>
              <button type="button" className="row between review-toggle" onClick={() => setOpen(expanded ? null : item.id)} aria-expanded={expanded}>
                <span className="row" style={{ minWidth: 0 }}>
                  <span className={clsx('dot', 'done', scoreTone(item.score))}>{i + 1}</span>
                  <strong className="grow" style={{ textAlign: 'left' }}>{item.question.title}</strong>
                </span>
                <span className="row small muted">
                  {item.gradeStatus === 'pending' ? <Spinner label="Grading" /> : `${pct(item.score)}%`}
                  <span aria-hidden>{expanded ? '▴' : '▾'}</span>
                </span>
              </button>
              {expanded && (
                <>
                  <QuestionHeader q={item.question} meta={meta} />
                  <AnswerInput q={item.question} draft={item.response ?? {}} setDraft={() => undefined}
                    components={meta?.taxonomy.components ?? []} locked reveal={item.reveal} />
                  <Feedback item={item} llm={session.llm} busy={busy}
                    onSelfGrade={(covered) => run(async () => set(await api.selfGrade(item.id, covered)), 'Self-grade saved')}
                    onRegrade={() => run(async () => { await api.regrade(item.id); set(await api.session(session.id)); })} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function scoreTone(score: number | null | undefined): 'good' | 'bad' | undefined {
  if (score == null) return undefined;
  if (score >= 0.7) return 'good';
  if (score < 0.4) return 'bad';
  return undefined;
}
