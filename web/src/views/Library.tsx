import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useDeferredValue, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { LANG_NAMES } from '../components/highlight';
import { pct, Pips, Spinner, useAction } from '../components/ui';
import { domainName, keys, typeName, useMeta } from '../hooks';
import type { QuestionSummary } from '../types';

export default function Library() {
  const meta = useMeta().data;
  const nav = useNavigate();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const [domain, setDomain] = useState('');
  const [type, setType] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const q = useDeferredValue(text);
  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (domain) f.domain = domain;
    if (type) f.type = type;
    if (difficulty) f.difficulty = difficulty;
    if (q.trim()) f.q = q.trim();
    return f;
  }, [domain, type, difficulty, q]);
  const { data, isLoading, error } = useQuery({ queryKey: ['questions', filters], queryFn: () => api.questions(filters) });

  const grouped = useMemo(() => {
    const m = new Map<string, QuestionSummary[]>();
    for (const x of data ?? []) m.set(x.domain, [...(m.get(x.domain) ?? []), x]);
    return [...m.entries()];
  }, [data]);

  const drill = (ids: string[], name: string) =>
    run(async () => {
      const r = await api.createRegiment(name, '', { questionIds: ids, perDay: ids.length, days: 1, feedback: 'immediate', difficultyMin: 1, difficultyMax: 5 });
      await qc.invalidateQueries({ queryKey: keys.regiments });
      nav(`/sessions/${r.sessions[0].id}`);
    });

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <div className="eyebrow">Library</div>
          <h1>Question bank</h1>
          <p className="lede">Browse by subject, concept and type. Prompts and answers stay hidden until you drill a question.</p>
        </div>
        {picked.length > 0 && (
          <div className="row">
            <button type="button" className="btn ghost" onClick={() => setPicked([])}>Clear {picked.length}</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => drill(picked, `Hand-picked set (${picked.length})`)}>Drill {picked.length} selected</button>
          </div>
        )}
      </div>

      <div className="glass stack">
        <div className="row wrap">
          <input className="input" style={{ maxWidth: 320 }} placeholder="Search titles and concepts" aria-label="Search" value={text} onChange={(e) => setText(e.target.value)} />
          <select className="select" style={{ maxWidth: 260 }} aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">All domains</option>
            {meta?.taxonomy.domains.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
          </select>
          <select className="select" style={{ maxWidth: 200 }} aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {meta?.taxonomy.types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
          </select>
          <select className="select" style={{ maxWidth: 170 }} aria-label="Difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            <option value="">Any level</option>
            {[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>Level {d}</option>)}
          </select>
          <span className="faint small">{data?.length ?? 0} questions</span>
        </div>
      </div>

      {isLoading ? <div className="empty"><Spinner /></div> : error ? (
        <div className="glass empty">Could not load the library: {(error as Error).message}</div>
      ) : grouped.length === 0 ? (
        <div className="glass empty">Nothing matches.</div>
      ) : grouped.map(([d, list]) => (
        <section key={d} className="stack sm">
          <h3>{domainName(meta, d)} <span className="faint small">{list.length}</span></h3>
          <div className="glass flush">
            {list.map((x) => (
              <div key={x.id} className="list-row">
                <input type="checkbox" aria-label={`Select ${x.title}`} checked={picked.includes(x.id)}
                  onChange={() => setPicked((p) => (p.includes(x.id) ? p.filter((y) => y !== x.id) : [...p, x.id]))} />
                <span className="grow">
                  <strong>{x.title}</strong>
                  <br />
                  <span className="row wrap small" style={{ gap: 6, marginTop: 4 }}>
                    <span className="tag">{typeName(meta, x.type)}</span>
                    {x.language && <span className="tag">{LANG_NAMES[x.language]}</span>}
                    <Pips n={x.difficulty} />
                    <span className="faint">{x.concepts.map((c) => c.replace(/-/g, ' ')).join(' · ')}</span>
                  </span>
                </span>
                <span className={clsx('small mono', x.attempts === 0 && 'faint')}>{x.attempts ? `best ${pct(x.bestScore)}%` : 'new'}</span>
                <button type="button" className="btn sm light" disabled={busy} onClick={() => drill([x.id], `Drill: ${x.title}`)}>Drill</button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
