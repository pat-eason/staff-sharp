import clsx from 'clsx';
import { useState } from 'react';
import type { Item } from '../types';
import { Lcd, Markdown, pct, Spinner } from './ui';

interface Props {
  item: Item;
  llm: boolean;
  onSelfGrade: (covered: number[]) => void;
  onRegrade: () => void;
  busy?: boolean;
}

const GRADER_LABEL: Record<string, string> = {
  auto: 'Graded automatically',
  llm: 'Graded by the model',
  heuristic: 'Provisional keyword match',
  self: 'Self-assessed',
};

function verdictTone(score: number): 'good' | 'mid' | 'bad' {
  if (score >= 0.7) return 'good';
  if (score >= 0.4) return 'mid';
  return 'bad';
}

/** The reveal after an answer: score, answer key, grader feedback and the explanation. */
export default function Feedback({ item, llm, onSelfGrade, onRegrade, busy }: Props) {
  const rv = item.reveal;
  const q = item.question;
  const g = item.grade;
  const pending = item.gradeStatus === 'pending';
  const rubric = rv?.rubric;
  const covered = new Set(g?.self?.covered ?? g?.llm?.keyPointsCovered ?? g?.auto?.keyPointsCovered ?? []);
  const [selfPick, setSelfPick] = useState<Set<number> | null>(null);
  const canSelfGrade = !!rubric && !pending && item.gradedBy !== 'llm' && item.status === 'submitted';
  const [showExemplar, setShowExemplar] = useState(false);
  if (!rv || !q) return null;
  const score = item.score ?? 0;

  return (
    <div className="feedback stack">
      <div className="row wrap between">
        <div className="row wrap">
          <Lcd label="Accuracy" value={pending ? '··' : pct(item.score)} unit="%" hot={!pending && score < 0.4} />
          <Lcd label="Potential" value={pending ? '··' : pct(item.potential)} unit="%" />
          {item.status === 'skipped' && <span className="tag bad">Not answered</span>}
          {!pending && item.status !== 'skipped' && (
            <span className={clsx('tag', verdictTone(score))}>{g?.llm?.verdict?.replace('_', ' ') ?? (score >= 0.7 ? 'correct' : score >= 0.4 ? 'partial' : 'missed')}</span>
          )}
        </div>
        <div className="row small muted">
          {pending ? (
            <><Spinner label="Grading" /> Grading your answer…</>
          ) : (
            item.gradedBy && <span>{GRADER_LABEL[item.gradedBy]}</span>
          )}
          {item.gradeStatus === 'failed' && <span className="tag bad" data-tip={item.gradeError}>Model grading failed</span>}
          {llm && !pending && item.status === 'submitted' && ['free_text', 'diagram', 'code_review', 'bug_hunt'].includes(q.type) && (
            <button type="button" className="btn sm ghost" disabled={busy} onClick={onRegrade}>{item.gradedBy === 'llm' ? 'Regrade' : 'Grade with model'}</button>
          )}
        </div>
      </div>

      {item.gradeStatus === 'failed' && item.gradeError && <p className="small muted">{item.gradeError}</p>}

      {g?.llm && (
        <div className="inset stack sm">
          <strong>{g.llm.summary}</strong>
          <div className="grid two">
            {g.llm.strengths.length > 0 && (
              <div>
                <span className="eyebrow">Landed</span>
                <ul className="tight-list">{g.llm.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
            {g.llm.gaps.length > 0 && (
              <div>
                <span className="eyebrow">Missing</span>
                <ul className="tight-list">{g.llm.gaps.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
          </div>
          <Markdown>{g.llm.feedback}</Markdown>
          {g.llm.followUp && (
            <p className="followup"><span className="eyebrow">An interviewer would ask next</span><br />{g.llm.followUp}</p>
          )}
        </div>
      )}

      {q.type === 'numeric' && rv.numeric && (
        <p>
          Expected about <strong>{rv.numeric.answer.toLocaleString()} {rv.numeric.unit}</strong>
          {item.response?.value != null && <> · you said {item.response.value.toLocaleString()}</>}
          {g?.auto?.ratio != null && <> · off by {g.auto.ratio.toFixed(2)}×</>}
          <span className="muted"> (full credit within {rv.numeric.fullCreditRatio}×)</span>
        </p>
      )}

      {q.type === 'ordering' && rv.order && (
        <div>
          <span className="eyebrow">Correct order</span>
          <ol className="tight-list">
            {rv.order.map((o, i) => {
              const yours = item.response?.order?.indexOf(o.id);
              return (
                <li key={o.id}>
                  {o.text}{' '}
                  {yours != null && yours >= 0 && yours !== i && <span className="tag mid">you had #{yours + 1}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {(q.type === 'code_review' || q.type === 'bug_hunt') && g?.auto && (
        <p className="small">
          Found {g.auto.foundIssues?.length ?? 0} of {(g.auto.foundIssues?.length ?? 0) + (g.auto.missedIssues?.length ?? 0)} issues by line
          {g.auto.falseFlags && g.auto.falseFlags.length > 0 && <> · {g.auto.falseFlags.length} comment(s) on lines with no known issue</>}.
          Issues are highlighted in the code above.
        </p>
      )}

      {q.type === 'diagram' && g?.auto?.componentsMissed && g.auto.componentsMissed.length > 0 && (
        <p className="small">Components a strong answer usually includes that your diagram lacks: {g.auto.componentsMissed.map((c) => c.replace(/[|_]/g, (m) => (m === '|' ? ' or ' : ' '))).join(', ')}.</p>
      )}

      {rubric && (
        <div className="stack sm">
          <div className="row between wrap">
            <span className="eyebrow">Key points a strong answer covers</span>
            {canSelfGrade && selfPick === null && (
              <button type="button" className="btn sm light" onClick={() => setSelfPick(new Set(covered))}>Self-grade against these</button>
            )}
          </div>
          <ul className="keypoints">
            {rubric.keyPoints.map((k, i) => {
              const checked = selfPick ? selfPick.has(i) : covered.has(i);
              return (
                <li key={i} className={clsx(checked && 'hit')}>
                  {selfPick ? (
                    <label>
                      <input type="checkbox" checked={checked} onChange={() => {
                        const next = new Set(selfPick);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        setSelfPick(next);
                      }} />{' '}
                      {k}
                    </label>
                  ) : (
                    <><span className="kp-mark" aria-label={checked ? 'covered' : 'not covered'}>{checked ? '✓' : '○'}</span> {k}</>
                  )}
                </li>
              );
            })}
          </ul>
          {selfPick && (
            <div className="row">
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => { onSelfGrade([...selfPick]); setSelfPick(null); }}>
                Save self-grade ({selfPick.size}/{rubric.keyPoints.length})
              </button>
              <button type="button" className="btn sm ghost" onClick={() => setSelfPick(null)}>Cancel</button>
            </div>
          )}
          {rubric.redFlags && rubric.redFlags.length > 0 && (
            <div className="small">
              <span className="eyebrow">Red flags</span>
              <ul className="tight-list">
                {rubric.redFlags.map((r, i) => (
                  <li key={i} className={clsx(g?.llm?.redFlagsHit?.includes(i) && 'flag-hit')}>{r}{g?.llm?.redFlagsHit?.includes(i) && ' — your answer did this'}</li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" className="btn sm ghost" onClick={() => setShowExemplar((v) => !v)}>
            {showExemplar ? 'Hide' : 'Show'} model answer
          </button>
          {showExemplar && <div className="inset"><Markdown>{rubric.exemplar}</Markdown></div>}
        </div>
      )}

      <div>
        <span className="eyebrow">Why</span>
        <Markdown>{rv.explanation}</Markdown>
        {rv.references && rv.references.length > 0 && (
          <p className="small muted">Further reading: {rv.references.join(' · ')}</p>
        )}
      </div>
    </div>
  );
}
