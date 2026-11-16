import { useId, useMemo, useRef, useState } from 'react';

/**
 * Small SVG charts for the Insights page. Colors come from validated theme tokens (--chart-a, --chart-b);
 * text always uses text tokens. One y-axis per chart: volume and percentages are never combined.
 */

export interface Series {
  key: string;
  name: string;
  tone: 'a' | 'b';
  values: (number | null)[]; // 0-1, aligned to labels; null = no data that week
}

const W = 720;
const PAD = { l: 40, r: 92, t: 16, b: 30 };

function fmtWeek(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function useHover(n: number, plotW: number) {
  const [i, setI] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const onMove = (e: React.PointerEvent) => {
    const svg = ref.current;
    if (!svg || n === 0) return;
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W - PAD.l;
    setI(Math.max(0, Math.min(n - 1, Math.round((x / plotW) * Math.max(1, n - 1)))));
  };
  return { i, ref, onMove, onLeave: () => setI(null) };
}

/** Weekly accuracy and potential: two lines on one 0-100% axis, crosshair tooltip, direct end labels. */
export function TrendChart({ labels, series, height = 260 }: { labels: string[]; series: Series[]; height?: number }) {
  const plotW = W - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const n = labels.length;
  const x = (i: number) => PAD.l + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.t + (1 - v) * plotH;
  const hover = useHover(n, plotW);

  // Break the path wherever a week has no answers.
  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const tickEvery = Math.max(1, Math.ceil(n / 8));
  const lastIdx = (vals: (number | null)[]) => { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i; return -1; };

  // Direct end labels: place each beside its last point, then push apart any that would overlap.
  const LABEL_GAP = 16;
  const endLabels = series
    .map((s) => {
      const li = lastIdx(s.values);
      return li < 0 ? null : { key: s.key, text: `${s.name} ${Math.round((s.values[li] as number) * 100)}%`, x: x(li) + 10, y: y(s.values[li] as number) };
    })
    .filter((l): l is { key: string; text: string; x: number; y: number } => l !== null)
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i++) {
    const overlap = endLabels[i - 1].y + LABEL_GAP - endLabels[i].y;
    if (overlap > 0) {
      endLabels[i - 1].y -= overlap / 2;
      endLabels[i].y += overlap / 2;
    }
  }

  return (
    <div className="chart">
      <svg ref={hover.ref} viewBox={`0 0 ${W} ${height}`} className="chart-svg" role="img"
        aria-label={`Weekly ${series.map((s) => s.name.toLowerCase()).join(' and ')} over ${n} weeks`}
        onPointerMove={hover.onMove} onPointerLeave={hover.onLeave}>
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line x1={PAD.l} x2={PAD.l + plotW} y1={y(g)} y2={y(g)} className="chart-grid" />
            <text x={PAD.l - 8} y={y(g)} className="chart-tick" textAnchor="end" dominantBaseline="middle">{g * 100}%</text>
          </g>
        ))}
        {labels.map((l, i) => (i % tickEvery === 0 || i === n - 1) && (
          <text key={l} x={x(i)} y={height - 8} className="chart-tick" textAnchor="middle">{fmtWeek(l)}</text>
        ))}
        {series.map((s) => (
          <g key={s.key}>
            <path d={path(s.values)} className={`chart-line tone-${s.tone}`} />
            {s.values.map((v, i) => v != null && (
              <circle key={i} cx={x(i)} cy={y(v)} r={hover.i === i ? 5 : 3.2} className={`chart-dot tone-${s.tone}`} />
            ))}
          </g>
        ))}
        {endLabels.map((l) => (
          <text key={l.key} x={l.x} y={l.y} className="chart-label" dominantBaseline="middle">{l.text}</text>
        ))}
        {hover.i != null && <line x1={x(hover.i)} x2={x(hover.i)} y1={PAD.t} y2={PAD.t + plotH} className="chart-crosshair" />}
      </svg>
      {hover.i != null && <Tip at={hover.i} x={x(hover.i)} labels={labels} series={series} />}
    </div>
  );
}

function Tip({ at, x, labels, series }: { at: number; x: number; labels: string[]; series: Series[] }) {
  return (
    <div className="chart-tip" style={{ left: `${(x / W) * 100}%` }}>
      <strong>Week of {fmtWeek(labels[at])}</strong>
      {series.map((s) => {
        const v = s.values[at];
        return <span key={s.key}><i className={`swatch tone-${s.tone}`} />{s.name}: {v == null ? 'no answers' : `${Math.round(v * 100)}%`}</span>;
      })}
    </div>
  );
}

/** Answers per week: one series of rounded bars on a count axis, per-bar tooltip. */
export function VolumeBars({ labels, values, unit, height = 150 }: { labels: string[]; values: number[]; unit: string; height?: number }) {
  const plotW = W - PAD.l - PAD.r;
  const plotH = height - PAD.t - PAD.b;
  const n = labels.length;
  const maxV = Math.max(1, ...values);
  const nice = maxV <= 5 ? maxV : Math.ceil(maxV / 5) * 5;
  const band = plotW / Math.max(1, n);
  const barW = Math.max(3, Math.min(28, band - 2));
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const tickEvery = Math.max(1, Math.ceil(n / 8));
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${height}`} className="chart-svg" role="img" aria-label={`${unit} per week over ${n} weeks`}>
        <line x1={PAD.l} x2={PAD.l + plotW} y1={PAD.t + plotH} y2={PAD.t + plotH} className="chart-axis" />
        <line x1={PAD.l} x2={PAD.l + plotW} y1={PAD.t} y2={PAD.t} className="chart-grid" />
        <text x={PAD.l - 8} y={PAD.t} className="chart-tick" textAnchor="end" dominantBaseline="middle">{nice}</text>
        <text x={PAD.l - 8} y={PAD.t + plotH} className="chart-tick" textAnchor="end" dominantBaseline="middle">0</text>
        {values.map((v, i) => {
          const h = (v / nice) * plotH;
          const bx = PAD.l + i * band + (band - barW) / 2;
          const r = Math.min(4, barW / 2, h);
          const top = PAD.t + plotH - h;
          return (
            <g key={labels[i]} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              {/* hit target taller and wider than the bar */}
              <rect x={PAD.l + i * band} y={PAD.t} width={band} height={plotH} fill="transparent" />
              {v > 0 && (
                <path className={`chart-bar ${hover === i ? 'on' : ''}`}
                  d={`M${bx},${PAD.t + plotH} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + barW - r} Q${bx + barW},${top} ${bx + barW},${top + r} V${PAD.t + plotH} Z`} />
              )}
            </g>
          );
        })}
        {labels.map((l, i) => (i % tickEvery === 0 || i === n - 1) && (
          <text key={`${id}-${l}`} x={PAD.l + i * band + band / 2} y={height - 8} className="chart-tick" textAnchor="middle">{fmtWeek(l)}</text>
        ))}
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: `${((PAD.l + hover * band + band / 2) / W) * 100}%` }}>
          <strong>Week of {fmtWeek(labels[hover])}</strong>
          <span>{values[hover]} {unit}</span>
        </div>
      )}
    </div>
  );
}

/** One domain's mastery trajectory: a single-series sparkline with its current value labelled. */
export function Spark({ values, label }: { values: (number | null)[]; label: string }) {
  const w = 160;
  const h = 40;
  const pts = useMemo(() => values.map((v, i) => (v == null ? null : [values.length <= 1 ? w / 2 : (i / (values.length - 1)) * (w - 8) + 4, 4 + (1 - v) * (h - 8)])), [values]);
  let d = '';
  let pen = false;
  for (const p of pts) {
    if (!p) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  const last = [...pts].reverse().find(Boolean);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" role="img" aria-label={label}>
      <line x1="4" x2={w - 4} y1={4 + 0.5 * (h - 8)} y2={4 + 0.5 * (h - 8)} className="chart-grid" />
      {d && <path d={d} className="chart-line tone-a" />}
      {last && <circle cx={last[0]} cy={last[1]} r="3.5" className="chart-dot tone-a" />}
    </svg>
  );
}
