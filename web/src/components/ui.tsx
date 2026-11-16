import clsx from 'clsx';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ---------------------------------------------------------------- toggle

interface ToggleProps extends Omit<ComponentPropsWithoutRef<'button'>, 'onChange'> {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
}

/** Skeuomorphic on/off switch. */
export function Toggle({ checked, onChange, label, hint, className, ...rest }: ToggleProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={clsx('toggle', checked && 'on', className)}
      onClick={() => onChange(!checked)} {...rest}>
      <span className="toggle-track"><span className="toggle-knob" /></span>
      {(label || hint) && (
        <span className="toggle-text">
          {label}
          {hint && <small>{hint}</small>}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------- segmented

interface SegProps<T extends string | number> {
  value: T;
  options: { value: T; label: ReactNode; tip?: string }[];
  onChange: (v: T) => void;
  accent?: boolean;
  ariaLabel: string;
  className?: string;
}

export function Seg<T extends string | number>({ value, options, onChange, accent, ariaLabel, className }: SegProps<T>) {
  return (
    <div className={clsx('seg', accent && 'accent', className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} data-tip={o.tip}
          className={clsx(o.value === value && 'on')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- readouts

export function Lcd({ label, value, unit, hot, big, className }: {
  label: string; value: ReactNode; unit?: string; hot?: boolean; big?: boolean; className?: string;
}) {
  return (
    <div className={clsx('lcd', hot && 'hot', big && 'big', className)}>
      <span className="lcd-label">{label}</span>
      <span className="lcd-value">{value}{unit && <small>{unit}</small>}</span>
    </div>
  );
}

export function pct(v: number | null | undefined): string {
  return v == null || Number.isNaN(v) ? '—' : String(Math.round(v * 100));
}

export function Meter({ value, accent, ghost, label }: { value: number; accent?: boolean; ghost?: boolean; label: string }) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div className={clsx('meter', accent && 'accent', ghost && 'ghost')} role="meter" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped * 100)}>
      <i style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

export function Pips({ n, of = 5, label }: { n: number; of?: number; label?: string }) {
  return (
    <span className="pips" role="img" aria-label={label ?? `Difficulty ${n} of ${of}`}>
      {Array.from({ length: of }, (_, i) => <span key={i} className={clsx('pip', i < n && 'on')} />)}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Field({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx('markdown', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------- knob

interface KnobProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  format?: (v: number) => ReactNode;
  size?: number;
}

const SWEEP = 270; // degrees of travel, like a studio pot

/**
 * Rotary knob from the audio-plugin school of skeuomorphism. Drag vertically, scroll, or use the
 * arrow keys; the value shows on an LCD below.
 */
export function Knob({ value, min, max, step = 1, onChange, label, format, size = 76 }: KnobProps) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step)), [min, max, step]);
  const frac = (value - min) / (max - min || 1);
  const angle = -SWEEP / 2 + frac * SWEEP;
  const range = max - min;

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, v: value };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dy = drag.current.y - e.clientY;
    onChange(clamp(drag.current.v + (dy / 160) * range));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const ticks = useMemo(() => Array.from({ length: 11 }, (_, i) => -SWEEP / 2 + (i / 10) * SWEEP), []);

  return (
    <div className="knob" style={{ '--knob': `${size}px` } as React.CSSProperties}>
      <div
        className="knob-dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(e) => onChange(clamp(value + (e.deltaY < 0 ? step : -step)))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); onChange(clamp(value + step)); }
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); onChange(clamp(value - step)); }
          if (e.key === 'Home') onChange(min);
          if (e.key === 'End') onChange(max);
        }}
      >
        {ticks.map((t, i) => (
          <span key={i} className={clsx('knob-tick', t <= angle + 0.01 && 'lit')} style={{ transform: `rotate(${t}deg)` }} />
        ))}
        <span className="knob-cap" style={{ transform: `rotate(${angle}deg)` }}>
          <span className="knob-pointer" />
        </span>
      </div>
      <div className="knob-row">
        <button type="button" className="knob-step" aria-label={`Decrease ${label}`} onClick={() => onChange(clamp(value - step))}>−</button>
        <span className="knob-value">{format ? format(value) : value}</span>
        <button type="button" className="knob-step" aria-label={`Increase ${label}`} onClick={() => onChange(clamp(value + step))}>+</button>
      </div>
      <span className="knob-label">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------- toasts

type Toast = { id: number; text: string; error?: boolean };
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, error?: boolean) => {
    const id = next.current++;
    setToasts((t) => [...t, { id, text, error }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={clsx('toast', t.error && 'error')}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Wraps an async action with a synchronous re-entrancy guard and an error toast. */
export function useAction() {
  const toast = useToast();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
      if (busyRef.current) return undefined;
      busyRef.current = true;
      setBusy(true);
      try {
        const out = await fn();
        if (ok) toast(ok);
        return out;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), true);
        return undefined;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}
