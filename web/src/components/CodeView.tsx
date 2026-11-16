import clsx from 'clsx';
import { useMemo, useState } from 'react';
import type { Comment, Lang, RevealIssue } from '../types';
import { tokenize } from './highlight';

interface Props {
  code: string;
  lang: Lang;
  comments: Comment[];
  onChange?: (comments: Comment[]) => void; // omitted = read-only
  severities?: boolean; // code review asks for a severity, bug hunt does not
  issues?: RevealIssue[]; // the answer key, shown after grading
}

const SEVERITIES = ['critical', 'major', 'minor'] as const;

/** Line-numbered code with inline review comments. Click a line (or its number) to comment on it. */
export default function CodeView({ code, lang, comments, onChange, severities, issues }: Props) {
  const lines = useMemo(() => code.split('\n').map((l) => tokenize(l, lang)), [code, lang]);
  const [editing, setEditing] = useState<{ line: number; text: string; severity: string } | null>(null);
  const issueLines = useMemo(() => {
    const m = new Map<number, RevealIssue[]>();
    for (const is of issues ?? []) for (const l of is.lines) m.set(l, [...(m.get(l) ?? []), is]);
    return m;
  }, [issues]);
  const readOnly = !onChange;

  const open = (line: number) => {
    if (readOnly) return;
    const existing = comments.find((c) => c.line === line);
    setEditing({ line, text: existing?.text ?? '', severity: existing?.severity ?? 'major' });
  };
  const save = () => {
    if (!editing || !onChange) return;
    const rest = comments.filter((c) => c.line !== editing.line);
    const next = editing.text.trim()
      ? [...rest, { line: editing.line, text: editing.text.trim(), ...(severities ? { severity: editing.severity } : {}) }]
      : rest;
    onChange(next.sort((a, b) => a.line - b.line));
    setEditing(null);
  };
  const remove = (line: number) => onChange?.(comments.filter((c) => c.line !== line));

  return (
    <div className={clsx('code', readOnly && 'readonly')}>
      {lines.map((tokens, i) => {
        const n = i + 1;
        const comment = comments.find((c) => c.line === n);
        const hits = issueLines.get(n);
        const near = issues && comment && !issues.some((is) => is.lines.some((l) => Math.abs(l - n) <= 1));
        return (
          <div key={n}>
            <div
              className={clsx('code-line', comment && 'has-comment', hits && 'issue', near && 'false-flag', editing?.line === n && 'editing')}
              onClick={() => open(n)}
              role={readOnly ? undefined : 'button'}
              tabIndex={readOnly ? undefined : 0}
              aria-label={readOnly ? undefined : `Comment on line ${n}`}
              onKeyDown={(e) => {
                if (!readOnly && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  open(n);
                }
              }}
            >
              <span className="code-num">{n}</span>
              <span className="code-src">
                {tokens.length === 0 ? ' ' : tokens.map((t, j) => <span key={j} className={`tk-${t.t}`}>{t.v}</span>)}
              </span>
              {!readOnly && <span className="code-add" aria-hidden>+</span>}
            </div>
            {editing?.line === n && (
              <div className="code-editor" onClick={(e) => e.stopPropagation()}>
                <textarea
                  className="textarea"
                  autoFocus
                  aria-label={`Comment for line ${n}`}
                  placeholder={severities ? 'What is wrong here, and what would you ask the author to change?' : 'What is the bug, and how would you fix it?'}
                  value={editing.text}
                  onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
                <div className="row between wrap">
                  {severities ? (
                    <div className="seg" role="radiogroup" aria-label="Severity">
                      {SEVERITIES.map((s) => (
                        <button key={s} type="button" role="radio" aria-checked={editing.severity === s}
                          className={clsx(editing.severity === s && 'on')} onClick={() => setEditing({ ...editing, severity: s })}>
                          {s}
                        </button>
                      ))}
                    </div>
                  ) : <span className="hint">⌘↵ to save</span>}
                  <div className="row">
                    <button type="button" className="btn sm ghost" onClick={() => setEditing(null)}>Cancel</button>
                    <button type="button" className="btn sm primary" onClick={save}>Save comment</button>
                  </div>
                </div>
              </div>
            )}
            {comment && editing?.line !== n && (
              <div className={clsx('code-comment', near && 'off')}>
                {comment.severity && <span className={clsx('tag', comment.severity === 'critical' ? 'bad' : comment.severity === 'major' ? 'mid' : undefined)}>{comment.severity}</span>}
                <span className="grow">{comment.text}</span>
                {!readOnly && (
                  <button type="button" className="btn sm ghost icon" aria-label={`Delete comment on line ${n}`} data-tip="Delete comment" onClick={() => remove(n)}>×</button>
                )}
              </div>
            )}
            {hits && issues && hits[0].lines[0] === n && (
              <div className="code-issue">
                {hits.map((is) => (
                  <div key={is.id}>
                    <span className={clsx('tag', is.severity === 'critical' ? 'bad' : is.severity === 'major' ? 'mid' : 'good')}>{is.severity}</span>{' '}
                    <strong>{is.summary}.</strong> <span className="muted">{is.fix}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
