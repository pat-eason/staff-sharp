import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * A skeuomorphic stopwatch-style chronograph in the spirit of the moonwatch: a steel case with two pushers
 * (no lugs or crown), black tachymeter bezel, black dial with three recessed registers, baton hands and a
 * domed crystal. The main hands tell the wall
 * time; the chronograph (central sweep hand, 30-minute and 12-hour registers) shows the session's
 * elapsed time and stops when paused, like the real complication. Both pushers start / stop it.
 * The time budget is drawn as an accent arc on the 30-minute register (or the 12-hour one beyond 30 min).
 */

interface Props {
  elapsedMs: number; // elapsed at `syncedAt`
  syncedAt: number; // performance.now() when elapsedMs was measured
  running: boolean;
  limitSeconds: number | null;
  onToggle: () => void;
  disabled?: boolean;
  size?: number;
}

const C = 200; // centre of the 400×400 dial space
const BEATS = 6; // 21,600 vph: the hands advance in sixths of a second

function polar(r: number, deg: number, cx = C, cy = C): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const [x1, y1] = polar(r, fromDeg, cx, cy);
  const [x2, y2] = polar(r, toDeg, cx, cy);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

const TACHY = [500, 400, 300, 250, 200, 175, 150, 125, 110, 100, 90, 80, 70, 60];

function fmt(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

function Register({ cx, cy, ticks, labels, labelFor, arc, children }: {
  cx: number; cy: number; ticks: number; labels: number[]; labelFor: (i: number) => number;
  arc?: { to: number; warn: boolean } | null; children?: React.ReactNode;
}) {
  const r = 36;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r + 2} fill="url(#sw-register-rim)" />
      <circle cx={cx} cy={cy} r={r} fill="url(#sw-register)" />
      {/* azurage: concentric snailing */}
      {Array.from({ length: 9 }, (_, i) => (
        <circle key={i} cx={cx} cy={cy} r={6 + i * 3.4} fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth="0.6" />
      ))}
      {arc && arc.to > 0 && (
        <path d={arcPath(cx, cy, r - 3.5, 0, Math.min(359.5, arc.to))} fill="none" stroke="#d23a00" strokeWidth="3.2"
          strokeLinecap="round" className={arc.warn ? 'sw-warn' : undefined} opacity="0.95" />
      )}
      {Array.from({ length: ticks }, (_, i) => {
        const deg = (i / ticks) * 360;
        const major = labels.includes(labelFor(i)) || i === 0;
        const [x1, y1] = polar(r - 1, deg, cx, cy);
        const [x2, y2] = polar(r - (major ? 7 : 4), deg, cx, cy);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#e9ecef" strokeWidth={major ? 1.3 : 0.6} />;
      })}
      {labels.map((v) => {
        const idx = Array.from({ length: ticks }, (_, i) => i).find((i) => labelFor(i) === v) ?? 0;
        const [x, y] = polar(r - 15, (idx / ticks) * 360, cx, cy);
        return (
          <text key={v} x={x} y={y + 3} textAnchor="middle" fontSize="8.5" fill="#e9ecef" fontFamily="var(--font-head)" fontWeight="600">
            {v}
          </text>
        );
      })}
      {children}
      <circle cx={cx} cy={cy} r="3" fill="url(#sw-pin)" />
    </g>
  );
}

export default function Watch({ elapsedMs, syncedAt, running, limitSeconds, onToggle, disabled, size }: Props) {
  const chronoSec = useRef<SVGGElement>(null);
  const chronoMin = useRef<SVGGElement>(null);
  const chronoHr = useRef<SVGGElement>(null);
  const runSec = useRef<SVGGElement>(null);
  const hourHand = useRef<SVGGElement>(null);
  const minuteHand = useRef<SVGGElement>(null);
  const [pressed, setPressed] = useState<'top' | 'bottom' | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  // Folded to a pill so it never covers a phone's answers; starts folded on narrow screens.
  const [mini, setMini] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 600px), (max-height: 520px)').matches);

  const elapsedAt = (t: number) => elapsedMs + (running ? t - syncedAt : 0);

  useEffect(() => {
    let raf = 0;
    let lastShown = -1;
    const tick = () => {
      const t = performance.now();
      const el = elapsedAt(t) / 1000;
      const beat = (x: number) => Math.floor(x * BEATS) / BEATS;
      chronoSec.current?.setAttribute('transform', `rotate(${(beat(el) % 60) * 6} ${C} ${C})`);
      chronoMin.current?.setAttribute('transform', `rotate(${(Math.floor(el / 60) % 30) * 12} 270 200)`);
      chronoHr.current?.setAttribute('transform', `rotate(${((el / 3600) % 12) * 30} 200 270)`);
      const now = new Date();
      const s = now.getSeconds() + now.getMilliseconds() / 1000;
      const m = now.getMinutes() + s / 60;
      const h = (now.getHours() % 12) + m / 60;
      runSec.current?.setAttribute('transform', `rotate(${beat(s) * 6} 130 200)`);
      minuteHand.current?.setAttribute('transform', `rotate(${m * 6} ${C} ${C})`);
      hourHand.current?.setAttribute('transform', `rotate(${h * 30} ${C} ${C})`);
      if (limitSeconds != null) {
        const rem = Math.ceil(limitSeconds - el);
        if (rem !== lastShown) {
          lastShown = rem;
          setRemaining(rem);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsedMs, syncedAt, running, limitSeconds]);

  const limit = limitSeconds ?? 0;
  const warn = remaining != null && limit > 0 && remaining <= Math.max(60, limit * 0.1);
  const minuteArc = limit > 0 && limit <= 1800 ? { to: (limit / 1800) * 360, warn } : null;
  const hourArc = limit > 1800 ? { to: (limit / 43200) * 360, warn } : null;

  const press = (which: 'top' | 'bottom') => {
    if (disabled) return;
    setPressed(which);
    window.setTimeout(() => setPressed(null), 140);
    onToggle();
  };

  // Static dial furniture is memoised: hundreds of ticks never need to re-render.
  const dial = useMemo(() => {
    const ticks = [];
    for (let i = 0; i < 300; i++) {
      const deg = i * 1.2;
      const five = i % 5 === 0;
      const [x1, y1] = polar(143, deg);
      const [x2, y2] = polar(five ? 134 : 138.5, deg);
      ticks.push(<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#eef0f1" strokeWidth={five ? 1.1 : 0.45} opacity={five ? 1 : 0.8} />);
    }
    const markers = [];
    for (let i = 0; i < 12; i++) {
      const deg = i * 30;
      if (i === 3 || i === 6 || i === 9) {
        const [x1, y1] = polar(128, deg);
        const [x2, y2] = polar(118, deg);
        markers.push(<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="url(#sw-lume)" strokeWidth="5" strokeLinecap="round" />);
        continue;
      }
      const [x1, y1] = polar(128, deg);
      const [x2, y2] = polar(i === 0 ? 100 : 104, deg);
      markers.push(
        <g key={i}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#c9cdd1" strokeWidth={i === 0 ? 8 : 6.5} strokeLinecap="round" />
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="url(#sw-lume)" strokeWidth={i === 0 ? 5.2 : 4} strokeLinecap="round" />
        </g>,
      );
    }
    const tachy = TACHY.map((v) => {
      const deg = ((3600 / v) / 60) * 360;
      const [x, y] = polar(158.5, deg);
      const [dx1, dy1] = polar(170, deg);
      const [dx2, dy2] = polar(166, deg);
      return (
        <g key={v}>
          <line x1={dx1} y1={dy1} x2={dx2} y2={dy2} stroke="#f2f2ee" strokeWidth="1.1" />
          <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize="11" fill="#f2f2ee"
            fontFamily="var(--font-head)" fontWeight="600" transform={`rotate(${deg} ${x} ${y})`}>
            {v === 90 ? '' : v}
          </text>
          {v === 90 && <circle cx={x} cy={y} r="2.6" fill="#f2f2ee" />}
        </g>
      );
    });
    const bezelTicks = [];
    for (let t = 8; t < 60; t += 0.5) {
      const deg = (t / 60) * 360;
      if (TACHY.some((v) => Math.abs(3600 / v - t) < 0.3)) continue;
      const [x1, y1] = polar(170, deg);
      const [x2, y2] = polar(t % 1 === 0 ? 167 : 168.5, deg);
      bezelTicks.push(<line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#d9dad6" strokeWidth="0.6" opacity="0.7" />);
    }
    return { ticks, markers, tachy, bezelTicks };
  }, []);

  const pusher = (which: 'top' | 'bottom', angle: number) => (
    <g
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={running ? 'Pause the watch (hides the question)' : 'Start the watch'}
      className="sw-pusher"
      onClick={() => press(which)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          press(which);
        }
      }}
      transform={`rotate(${angle} ${C} ${C})`}
    >
      <g style={{ transform: `translateX(${pressed === which ? -5 : 0}px)`, transition: 'transform 0.09s ease-out' }}>
        <rect x="368" y="188" width="30" height="24" rx="3" fill="url(#sw-steel-h)" stroke="#5f666d" strokeWidth="0.8" />
        <rect x="392" y="177" width="22" height="46" rx="9" fill="url(#sw-steel-v)" stroke="#4d545b" strokeWidth="1" />
        <rect x="395" y="181" width="6" height="38" rx="3" fill="rgba(255,255,255,0.6)" />
      </g>
    </g>
  );

  return (
    <div className={`sw ${running ? 'is-running' : 'is-paused'} ${mini ? 'is-mini' : ''}`} style={size ? ({ '--sw-size': `${size}px` } as React.CSSProperties) : undefined}>
      {!mini && (
      <svg viewBox="2 -6 424 412" role="img"
        aria-label={`Chronograph. ${running ? 'Running' : 'Paused'}${remaining != null ? `, ${fmt(remaining)} remaining` : ''}`}>
        <defs>
          <radialGradient id="sw-case" cx="0.38" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.35" stopColor="#d5dade" />
            <stop offset="0.7" stopColor="#8f979e" />
            <stop offset="1" stopColor="#5b6269" />
          </radialGradient>
          <linearGradient id="sw-steel-h" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f4f6f7" />
            <stop offset="0.5" stopColor="#a8b0b6" />
            <stop offset="1" stopColor="#6c747b" />
          </linearGradient>
          <linearGradient id="sw-steel-v" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#7c858c" />
            <stop offset="0.4" stopColor="#eef1f3" />
            <stop offset="1" stopColor="#6d757c" />
          </linearGradient>
          <radialGradient id="sw-bezel" cx="0.5" cy="0.45" r="0.55">
            <stop offset="0.82" stopColor="#1a1c1f" />
            <stop offset="1" stopColor="#060708" />
          </radialGradient>
          <radialGradient id="sw-dial" cx="0.45" cy="0.38" r="0.7">
            <stop offset="0" stopColor="#1b1e22" />
            <stop offset="0.7" stopColor="#0b0d0f" />
            <stop offset="1" stopColor="#040505" />
          </radialGradient>
          <radialGradient id="sw-register" cx="0.5" cy="0.4" r="0.65">
            <stop offset="0" stopColor="#15181b" />
            <stop offset="1" stopColor="#050607" />
          </radialGradient>
          <radialGradient id="sw-register-rim" cx="0.5" cy="0.6" r="0.6">
            <stop offset="0.85" stopColor="#000" />
            <stop offset="1" stopColor="#2a2e33" />
          </radialGradient>
          <linearGradient id="sw-lume" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fbfbf3" />
            <stop offset="1" stopColor="#e2e6d6" />
          </linearGradient>
          <radialGradient id="sw-pin" cx="0.35" cy="0.3" r="0.7">
            <stop offset="0" stopColor="#fff" />
            <stop offset="1" stopColor="#8c949b" />
          </radialGradient>
          <radialGradient id="sw-crystal" cx="0.3" cy="0.18" r="0.75">
            <stop offset="0" stopColor="rgba(255,255,255,0.32)" />
            <stop offset="0.35" stopColor="rgba(255,255,255,0.07)" />
            <stop offset="1" stopColor="rgba(255,255,255,0)" />
          </radialGradient>
          <linearGradient id="sw-glint" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgba(255,255,255,0.55)" />
            <stop offset="1" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
          <path id="sw-tachy-arc" d={arcPath(C, C, 154, 118, 178)} />
          <filter id="sw-shadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="10" stdDeviation="10" floodColor="#00060d" floodOpacity="0.7" />
          </filter>
          <filter id="sw-hand-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="2.5" dy="3.5" stdDeviation="1.6" floodColor="#000" floodOpacity="0.75" />
          </filter>
        </defs>

        <g filter="url(#sw-shadow)">
          {pusher('top', -40)}
          {pusher('bottom', 40)}
          {/* case */}
          <circle cx={C} cy={C} r="184" fill="url(#sw-case)" stroke="#545b61" strokeWidth="1.2" />
          <circle cx={C} cy={C} r="176" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="1.4" />
        </g>

        {/* bezel */}
        <circle cx={C} cy={C} r="173" fill="url(#sw-bezel)" />
        <circle cx={C} cy={C} r="172.5" fill="none" stroke="#3a3f44" strokeWidth="1" />
        {dial.bezelTicks}
        {dial.tachy}
        <text fontSize="9.5" fill="#f2f2ee" fontFamily="var(--font-head)" fontWeight="600" letterSpacing="2.4">
          <textPath href="#sw-tachy-arc" startOffset="50%" textAnchor="middle">TACHYMETRE</textPath>
        </text>
        <circle cx={C} cy={C} r="146" fill="none" stroke="#9aa1a7" strokeWidth="2.2" />

        {/* dial */}
        <circle cx={C} cy={C} r="145" fill="url(#sw-dial)" />
        {dial.ticks}
        {dial.markers}
        <text x={C} y="96" textAnchor="middle" fontSize="12.5" fill="#f4f4ef" fontFamily="var(--font-head)" fontWeight="700" letterSpacing="2.6">
          STAFF SHARP
        </text>
        <text x={C} y="113" textAnchor="middle" fontSize="13" fill="#f4f4ef" fontFamily="Georgia, 'Times New Roman', serif" fontStyle="italic">
          Chronograph
        </text>
        <text x={C} y="125" textAnchor="middle" fontSize="6.6" fill="#c9ccc7" fontFamily="var(--font-head)" fontWeight="600" letterSpacing="2.2">
          TIMED SET
        </text>

        {/* registers: running seconds (9), 30-minute counter (3), 12-hour counter (6) */}
        <Register cx={130} cy={200} ticks={60} labels={[20, 40, 60]} labelFor={(i) => (i === 0 ? 60 : i)}>
          <g ref={runSec}>
            <line x1="130" y1="206" x2="130" y2="170" stroke="#f4f4ef" strokeWidth="1.6" strokeLinecap="round" />
          </g>
        </Register>
        <Register cx={270} cy={200} ticks={30} labels={[10, 20, 30]} labelFor={(i) => (i === 0 ? 30 : i)} arc={minuteArc}>
          <g ref={chronoMin}>
            <line x1="270" y1="206" x2="270" y2="170" stroke="#f4f4ef" strokeWidth="1.8" strokeLinecap="round" />
          </g>
        </Register>
        <Register cx={200} cy={270} ticks={12} labels={[3, 6, 9, 12]} labelFor={(i) => (i === 0 ? 12 : i)} arc={hourArc}>
          <g ref={chronoHr}>
            <line x1="200" y1="276" x2="200" y2="242" stroke="#f4f4ef" strokeWidth="1.8" strokeLinecap="round" />
          </g>
        </Register>

        {/* main hands: wall time */}
        <g ref={hourHand} filter="url(#sw-hand-shadow)">
          <path d={`M ${C - 4.5} ${C + 16} L ${C - 4.5} ${C - 70} L ${C} ${C - 82} L ${C + 4.5} ${C - 70} L ${C + 4.5} ${C + 16} Z`} fill="#d9dde0" stroke="#7d858c" strokeWidth="0.6" />
          <rect x={C - 2.4} y={C - 72} width="4.8" height="56" rx="2" fill="url(#sw-lume)" />
        </g>
        <g ref={minuteHand} filter="url(#sw-hand-shadow)">
          <path d={`M ${C - 3.6} ${C + 18} L ${C - 3.6} ${C - 112} L ${C} ${C - 126} L ${C + 3.6} ${C - 112} L ${C + 3.6} ${C + 18} Z`} fill="#d9dde0" stroke="#7d858c" strokeWidth="0.6" />
          <rect x={C - 1.9} y={C - 114} width="3.8" height="94" rx="1.8" fill="url(#sw-lume)" />
        </g>
        {/* chronograph seconds: the accent hand */}
        <g ref={chronoSec} filter="url(#sw-hand-shadow)">
          <line x1={C} y1={C + 34} x2={C} y2={C - 140} stroke="#d23a00" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx={C} cy={C + 28} r="4.2" fill="#d23a00" />
          <rect x={C - 1.5} y={C - 120} width="3" height="14" rx="1" fill="#ff8a55" />
        </g>
        <circle cx={C} cy={C} r="6.5" fill="#d23a00" stroke="#7a2200" strokeWidth="0.8" />
        <circle cx={C} cy={C} r="2.6" fill="url(#sw-pin)" />

        {/* domed hesalite crystal */}
        <circle cx={C} cy={C} r="146" fill="url(#sw-crystal)" pointerEvents="none" />
        <path d={arcPath(C, C, 136, 292, 352)} fill="none" stroke="url(#sw-glint)" strokeWidth="9" strokeLinecap="round" opacity="0.55" pointerEvents="none" />
      </svg>
      )}
      <div className={`sw-readout ${warn ? 'warn' : ''}`}>
        {mini && (
          <button type="button" className="sw-mini-toggle" onClick={() => press('top')} disabled={disabled}
            aria-label={running ? 'Pause the watch (hides the question)' : 'Start the watch'}>
            {running ? '❚❚' : '▶'}
          </button>
        )}
        <button type="button" className="sw-fold" onClick={() => setMini((m) => !m)} aria-expanded={!mini}
          aria-label={mini ? 'Show the watch face' : 'Fold the watch to a small readout'} data-tip={mini ? 'Show the watch' : 'Fold the watch'}>
          <span className="sw-state">{running ? 'Running' : 'Paused'}</span>
          <span className="sw-time">{remaining != null ? fmt(remaining) : fmt(elapsedAt(performance.now()) / 1000)}</span>
          <span className="sw-hint">{remaining != null ? 'left' : 'elapsed'}</span>
          <span className="sw-chevron" aria-hidden>{mini ? '▴' : '▾'}</span>
        </button>
      </div>
    </div>
  );
}
