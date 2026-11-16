import clsx from 'clsx';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/*
 * In-app replacements for the browser's native UI: every hover description is a design-system popover
 * (driven by a `data-tip` attribute, optionally `data-tip-side`), and confirmations and text prompts
 * are in-app dialogs. Never use the `title` attribute, window.confirm, window.prompt or window.alert.
 */

type Side = 'top' | 'bottom' | 'left' | 'right';
type Tip = { text: string; rect: DOMRect; side: Side; id: string };

const GAP = 10;
const SHOW_DELAY_MS = 280;

/** The UI is zoomed on 2K/4K screens; the layer matches it, so positions are divided by the same factor. */
function uiZoom(): number {
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom'));
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function place(rect: DOMRect, w: number, h: number, side: Side): { x: number; y: number; side: Side } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fits: Record<Side, boolean> = {
    top: rect.top - h - GAP >= 4,
    bottom: rect.bottom + h + GAP <= vh - 4,
    right: rect.right + w + GAP <= vw - 4,
    left: rect.left - w - GAP >= 4,
  };
  const flip: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const s = fits[side] ? side : fits[flip[side]] ? flip[side] : side;
  let x = 0;
  let y = 0;
  if (s === 'top' || s === 'bottom') {
    x = rect.left + rect.width / 2 - w / 2;
    y = s === 'top' ? rect.top - h - GAP : rect.bottom + GAP;
  } else {
    x = s === 'right' ? rect.right + GAP : rect.left - w - GAP;
    y = rect.top + rect.height / 2 - h / 2;
  }
  return { x: Math.max(6, Math.min(vw - w - 6, x)), y: Math.max(6, Math.min(vh - h - 6, y)), side: s };
}

/** Renders the popover for whichever `[data-tip]` element is hovered or keyboard-focused. Mount once. */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; side: Side } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const current = useRef<HTMLElement | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      current.current?.removeAttribute('aria-describedby');
      current.current = null;
      setTip(null);
      setPos(null);
    };
    const show = (el: HTMLElement, delay: number) => {
      const text = el.dataset.tip;
      if (!text) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (!el.isConnected) return;
        current.current?.removeAttribute('aria-describedby');
        current.current = el;
        const id = `tip-${++seq.current}`;
        el.setAttribute('aria-describedby', id);
        setPos(null);
        setTip({ text, rect: el.getBoundingClientRect(), side: (el.dataset.tipSide as Side) || 'top', id });
      }, delay);
    };
    const target = (e: Event) => (e.target instanceof Element ? (e.target.closest('[data-tip]') as HTMLElement | null) : null);
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = target(e);
      if (el && el !== current.current) show(el, SHOW_DELAY_MS);
      if (!el) hide();
    };
    const onOut = (e: PointerEvent) => {
      const el = target(e);
      const into = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-tip]') : null;
      if (el && into !== el) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = target(e);
      if (el && (e.target as HTMLElement).matches(':focus-visible')) show(el, 0);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);

  // Measure, then place against the viewport (flipping sides when there is no room).
  useLayoutEffect(() => {
    if (!tip || !box.current) return;
    const z = uiZoom();
    const r = box.current.getBoundingClientRect();
    const p = place(tip.rect, r.width, r.height, tip.side);
    setPos({ x: p.x / z, y: p.y / z, side: p.side });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div className="tip-layer">
      <div ref={box} id={tip.id} role="tooltip" className={clsx('tip', pos && `tip-${pos.side}`, pos && 'shown')}
        style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}>
        {tip.text}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- dialogs

type ConfirmOptions = { title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
type PromptOptions = { title: string; body?: ReactNode; label: string; initial?: string; placeholder?: string; confirmLabel?: string };
type Request =
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (value: string | null) => void } & PromptOptions);

interface DialogApi {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  prompt: (o: PromptOptions) => Promise<string | null>;
}

const DialogCtx = createContext<DialogApi>({ confirm: async () => false, prompt: async () => null });

/** In-app confirm and prompt dialogs. `const { confirm } = useDialog(); if (await confirm({...}))`. */
export const useDialog = () => useContext(DialogCtx);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<Request | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setReq({ kind: 'confirm', resolve, ...o })), []);
  const prompt = useCallback((o: PromptOptions) => new Promise<string | null>((resolve) => setReq({ kind: 'prompt', resolve, ...o })), []);
  const api = useRef({ confirm, prompt }).current;
  return (
    <DialogCtx.Provider value={api}>
      {children}
      {req && <Dialog req={req} onDone={() => setReq(null)} />}
    </DialogCtx.Provider>
  );
}

function Dialog({ req, onDone }: { req: Request; onDone: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(document.activeElement);
  const [value, setValue] = useState(req.kind === 'prompt' ? (req.initial ?? '') : '');
  const finish = (ok: boolean) => {
    if (req.kind === 'confirm') req.resolve(ok);
    else req.resolve(ok ? value : null);
    onDone();
    (restore.current as HTMLElement | null)?.focus?.();
  };

  useEffect(() => {
    const first = card.current?.querySelector<HTMLElement>('input, button.primary, button');
    first?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
    if (e.key === 'Tab' && card.current) {
      // keep focus inside the dialog
      const items = [...card.current.querySelectorAll<HTMLElement>('input, button')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1]?.focus(); }
      if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0]?.focus(); }
    }
  };

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(false)}>
      <div ref={card} className="dialog porcelain" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onKeyDown={onKeyDown}>
        <h3 id="dialog-title">{req.title}</h3>
        {req.body && <div className="muted">{req.body}</div>}
        {req.kind === 'prompt' && (
          <form className="field" onSubmit={(e) => { e.preventDefault(); finish(true); }}>
            <label htmlFor="dialog-input">{req.label}</label>
            <input id="dialog-input" className="input" value={value} placeholder={req.placeholder} onChange={(e) => setValue(e.target.value)} />
          </form>
        )}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={() => finish(false)}>{req.kind === 'confirm' ? (req.cancelLabel ?? 'Cancel') : 'Cancel'}</button>
          <button type="button" className={clsx('btn', 'primary')} onClick={() => finish(true)}>
            {req.confirmLabel ?? (req.kind === 'prompt' ? 'Save' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
