import { useId } from 'react';

export interface StarAxis {
  key: string;
  label: string;
  focal?: boolean;
  primary?: boolean;
  empty?: boolean; // no evidence yet
}

export interface StarSeries {
  name: string;
  values: number[]; // 0-1, one per axis
  tone: 'porcelain' | 'accent';
}

interface Props {
  axes: StarAxis[];
  series: StarSeries[];
  compact?: boolean;
  title: string;
}

const S = 600;
const C = S / 2;

function point(i: number, n: number, r: number): [number, number] {
  const a = (Math.PI * 2 * i) / n - Math.PI / 2;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

/**
 * Radar ("star") plot of mastery by domain. Focal points are marked with an accent dot on their label;
 * the primary focus gets an accent star. Axes with no answers yet are drawn dashed.
 */
export default function StarPlot({ axes, series, compact, title }: Props) {
  const id = useId().replace(/:/g, '');
  const n = axes.length;
  const R = compact ? 230 : 200;
  const rings = [0.25, 0.5, 0.75, 1];
  const poly = (vals: number[]) => vals.map((v, i) => point(i, n, Math.max(0.02, v) * R).join(',')).join(' ');

  return (
    <svg className="star-plot" viewBox={compact ? '-95 0 790 600' : '-60 -10 720 620'} role="img" aria-label={title}>
      <defs>
        <radialGradient id={`${id}-bg`} cx="0.5" cy="0.42" r="0.6">
          <stop offset="0" style={{ stopColor: 'var(--star-well-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--star-well-b)' }} />
        </radialGradient>
        <linearGradient id={`${id}-porcelain`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--star-mastery)', stopOpacity: 0.5 }} />
          <stop offset="1" style={{ stopColor: 'var(--star-mastery)', stopOpacity: 0.14 }} />
        </linearGradient>
        <linearGradient id={`${id}-accent`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(255,106,43,0.35)" />
          <stop offset="1" stopColor="rgba(210,58,0,0.12)" />
        </linearGradient>
        <radialGradient id={`${id}-gloss`} cx="0.4" cy="0.2" r="0.7">
          <stop offset="0" stopColor="rgba(255,255,255,0.16)" />
          <stop offset="0.5" stopColor="rgba(255,255,255,0.02)" />
          <stop offset="1" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      <circle cx={C} cy={C} r={R + 14} fill={`url(#${id}-bg)`} style={{ stroke: 'rgba(var(--star-ink),0.16)' }} />
      {rings.map((r) => (
        <polygon key={r} points={poly(axes.map(() => r))} fill="none" style={{ stroke: 'rgba(var(--star-ink),0.14)' }} strokeWidth={r === 1 ? 1.4 : 1} />
      ))}
      {axes.map((a, i) => {
        const [x, y] = point(i, n, R);
        return <line key={a.key} x1={C} y1={C} x2={x} y2={y} style={{ stroke: 'rgba(var(--star-ink),0.14)' }} strokeDasharray={a.empty ? '4 5' : undefined} />;
      })}
      {series.map((s) => (
        <g key={s.name}>
          <polygon points={poly(s.values)} fill={`url(#${id}-${s.tone})`}
            style={{ stroke: s.tone === 'accent' ? '#ff6a2b' : 'var(--star-mastery)' }} strokeWidth={s.tone === 'accent' ? 1.8 : 2.4}
            strokeDasharray={s.tone === 'accent' ? '6 5' : undefined} strokeLinejoin="round" />
          {s.values.map((v, i) => {
            const [x, y] = point(i, n, Math.max(0.02, v) * R);
            return <circle key={i} cx={x} cy={y} r={s.tone === 'accent' ? 3 : 4.2} style={{ fill: s.tone === 'accent' ? '#ff6a2b' : 'var(--star-mastery)', stroke: 'var(--star-well-a)' }} strokeWidth="1.4" />;
          })}
        </g>
      ))}
      <circle cx={C} cy={C} r={R + 14} fill={`url(#${id}-gloss)`} pointerEvents="none" />
      {!compact && rings.map((r) => (
        <text key={r} x={C + 4} y={C - r * R - 4} fontSize="11" style={{ fill: 'rgba(var(--star-ink),0.42)' }}>{r * 100}</text>
      ))}
      {axes.map((a, i) => {
        const [x, y] = point(i, n, R + (compact ? 34 : 40));
        const anchor = Math.abs(x - C) < 20 ? 'middle' : x > C ? 'start' : 'end';
        return (
          <text key={a.key} x={x} y={y} textAnchor={anchor} dominantBaseline="middle" fontSize={compact ? 19 : 15.5} fontWeight="600"
            style={{ fill: a.empty ? 'rgba(var(--star-ink),0.42)' : 'rgba(var(--star-ink),0.9)' }}>
            {(a.primary || a.focal) && <tspan fill="#ff6a2b">{a.primary ? '★ ' : '● '}</tspan>}
            <tspan>{a.label}</tspan>
          </text>
        );
      })}
    </svg>
  );
}
