import { Link } from 'react-router-dom';
import { pct, Spinner } from '../components/ui';
import { useRegiments } from '../hooks';

export default function Regiments() {
  const { data, isLoading, error } = useRegiments();
  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <div className="eyebrow">Regiments</div>
          <h1>Your regiments</h1>
          <p className="lede">Everything you have run, from one-question drills to month-long plans.</p>
        </div>
        <Link to="/regiments/new" className="btn primary lg">New regiment</Link>
      </div>
      {isLoading ? <div className="empty"><Spinner /></div> : error ? (
        <div className="glass empty">Could not load regiments: {(error as Error).message}</div>
      ) : !data || data.length === 0 ? (
        <div className="glass empty">
          <p>No regiments yet.</p>
          <Link to="/regiments/new" className="btn primary">Build your first</Link>
        </div>
      ) : (
        <div className="glass flush">
          {data.map((r) => (
            <Link key={r.id} to={`/regiments/${r.id}`} className="list-row">
              <span className={r.status === 'completed' ? 'tag good' : 'tag accent'}>{r.status === 'completed' ? 'done' : 'active'}</span>
              <span className="grow">
                <strong>{r.name}</strong>
                <br />
                <span className="small faint">
                  {r.daysCompleted}/{r.sessions.length} days · {r.config.perDay}/day{r.config.timed ? ' · timed' : ''} · {new Date(r.createdAt).toLocaleDateString()}
                </span>
              </span>
              <span className="mono">{r.accuracy != null ? `${pct(r.accuracy)}%` : '—'}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
