import clsx from 'clsx';
import { useState } from 'react';
import type { KeyName, PublicQuestion, Response, Reveal } from '../types';
import CodeView from './CodeView';
import DiagramEditor from './DiagramEditor';
import { LANG_NAMES } from './highlight';
import OrderingList from './OrderingList';
import { Markdown } from './ui';

const KEYS = 'ABCDEFG';

/** "12k", "1.5M", "3,200", "4e6" → number. */
export function parseNumber(s: string): number | undefined {
  const m = s.trim().replace(/,/g, '').match(/^(-?\d*\.?\d+(?:e[+-]?\d+)?)\s*([kmbgt])?$/i);
  if (!m) return undefined;
  const mult = { k: 1e3, m: 1e6, b: 1e9, g: 1e9, t: 1e12 }[(m[2] ?? '').toLowerCase() as 'k'] ?? 1;
  return Number(m[1]) * mult;
}

interface Props {
  q: PublicQuestion;
  draft: Response;
  setDraft: (r: Response) => void;
  components: KeyName[];
  locked: boolean; // submitted: show the answer, no editing
  reveal?: Reveal;
  onVariant?: (lang: string) => void;
}

/** The answer surface for one question, switched on its type. */
export default function AnswerInput({ q, draft, setDraft, components, locked, reveal, onVariant }: Props) {
  switch (q.type) {
    case 'mcq':
    case 'multi':
      return <Choices q={q} draft={draft} setDraft={setDraft} locked={locked} reveal={reveal} />;
    case 'numeric':
      return <NumericInput q={q} draft={draft} setDraft={setDraft} locked={locked} />;
    case 'ordering':
      return (
        <OrderingList items={q.items ?? []} order={draft.order ?? (q.items ?? []).map((i) => i.id)} disabled={locked}
          onChange={(order) => setDraft({ ...draft, order })} />
      );
    case 'free_text':
      return <Written draft={draft} setDraft={setDraft} locked={locked} placeholder="Answer as you would in a design review or interview: structure, tradeoffs, numbers, failure modes." />;
    case 'diagram':
      return (
        <div className="stack">
          <DiagramEditor key={`${q.id}-${locked}`} components={components} initial={draft.diagram}
            onChange={locked ? undefined : (diagram) => setDraft({ ...draft, diagram })} />
          <Written draft={draft} setDraft={setDraft} locked={locked} label="Walk through the design"
            placeholder="Request flow, data model, the bottleneck and how it scales, failure modes and what you would monitor." />
        </div>
      );
    case 'code_review':
    case 'bug_hunt':
      return (
        <div className="stack">
          {q.codeVariants && q.codeVariants.length > 1 && !locked && onVariant && (
            <div className="row wrap small">
              <span className="muted">Language</span>
              {q.codeVariants.map((l) => (
                <button key={l} type="button" className={clsx('chip', l === q.codeLanguage && 'on')} onClick={() => l !== q.codeLanguage && onVariant(l)}>
                  {LANG_NAMES[l]}
                </button>
              ))}
            </div>
          )}
          <p className="muted small" style={{ margin: 0 }}>
            {q.type === 'bug_hunt'
              ? 'Click the line with the bug and say what goes wrong and how to fix it.'
              : 'Click lines to leave review comments, with a severity for each. Comment on everything you would raise in a real review.'}
          </p>
          <CodeView code={q.code ?? ''} lang={q.codeLanguage ?? 'ts'} comments={draft.comments ?? []} severities={q.type === 'code_review'}
            onChange={locked ? undefined : (comments) => setDraft({ ...draft, comments })} issues={locked ? reveal?.issues : undefined} />
          <Written draft={draft} setDraft={setDraft} locked={locked} label="Overall notes (optional)" short
            placeholder={q.type === 'bug_hunt' ? 'Root cause and fix, if you want to say more.' : 'Summary review comment for the author.'} />
        </div>
      );
  }
}

function Choices({ q, draft, setDraft, locked, reveal }: Omit<Props, 'components' | 'onVariant'>) {
  const multi = q.type === 'multi';
  const selected = draft.selected ?? [];
  const toggle = (id: string) => {
    if (locked) return;
    if (!multi) return setDraft({ ...draft, selected: [id] });
    setDraft({ ...draft, selected: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] });
  };
  return (
    <div className="stack sm">
      {multi && <span className="eyebrow">Select all that apply</span>}
      <div className="options" role={multi ? 'group' : 'radiogroup'} aria-label="Options">
        {(q.options ?? []).map((o, i) => {
          const on = selected.includes(o.id);
          const isAnswer = reveal?.answer?.includes(o.id);
          return (
            <button
              key={o.id}
              type="button"
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={on}
              disabled={locked}
              className={clsx('option', multi && 'multi', on && 'on', reveal && isAnswer && 'correct', reveal && on && !isAnswer && 'wrong')}
              onClick={() => toggle(o.id)}
            >
              <span className="option-key">{KEYS[i]}</span>
              <span className="option-body">
                <Markdown>{o.text}</Markdown>
                {reveal?.optionNotes?.[o.id] && <span className="option-note">{reveal.optionNotes[o.id]}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NumericInput({ q, draft, setDraft, locked }: Pick<Props, 'q' | 'draft' | 'setDraft' | 'locked'>) {
  const [text, setText] = useState(draft.value != null ? String(draft.value) : '');
  const parsed = parseNumber(text);
  return (
    <div className="stack sm">
      <div className="numeric">
        <input className="input" inputMode="decimal" aria-label={`Estimate in ${q.unit}`} placeholder="0" value={text} disabled={locked}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseNumber(e.target.value);
            setDraft({ ...draft, value: v });
          }} />
        <span className="numeric-unit">{q.unit}</span>
      </div>
      <span className="hint">
        Shorthand works: 12k, 3.5M, 2e9.{' '}
        {text && (parsed == null ? 'Not a number yet.' : `Reads as ${parsed.toLocaleString()}.`)}
      </span>
    </div>
  );
}

function Written({ draft, setDraft, locked, placeholder, label, short }: {
  draft: Response; setDraft: (r: Response) => void; locked: boolean; placeholder: string; label?: string; short?: boolean;
}) {
  const words = (draft.text ?? '').trim().split(/\s+/).filter(Boolean).length;
  return (
    <div className="field">
      {label && <label htmlFor="answer-text">{label}</label>}
      <textarea id="answer-text" className="textarea" style={{ minHeight: short ? 80 : 220 }} placeholder={placeholder}
        aria-label={label ?? 'Your answer'} value={draft.text ?? ''} readOnly={locked}
        onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
      {!short && <span className="hint">{words} words · Markdown supported</span>}
    </div>
  );
}
