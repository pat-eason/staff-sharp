import clsx from 'clsx';
import { useRef, useState } from 'react';
import type { Option } from '../types';

interface Props {
  items: Option[];
  order: string[];
  onChange: (order: string[]) => void;
  disabled?: boolean;
}

type Drag = {
  id: string;
  from: number;
  over: number;
  dy: number;
  startY: number;
  pointerId: number;
  slots: { top: number; height: number }[]; // each row's resting box, measured at pick-up
};

const GAP = 8; // must match .order-list gap

/**
 * Reorderable list. Drag a row (anywhere with a mouse, by the grip on touch so the page still scrolls);
 * the row lifts and follows the pointer while the others slide aside to show where it will land.
 * The arrow buttons, and Arrow Up/Down on a focused grip, do the same from the keyboard.
 */
export default function OrderingList({ items, order, onChange, disabled }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // On drop the order and every transform change in the same render; skip transitions for that frame.
  const [settling, setSettling] = useState(false);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const byId = new Map(items.map((i) => [i.id, i]));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
  };

  const start = (e: React.PointerEvent, id: string, idx: number, viaGrip: boolean) => {
    if (disabled || e.button !== 0) return;
    if (e.pointerType !== 'mouse' && !viaGrip) return; // touch scrolls unless the grip is used
    if ((e.target as Element).closest('button')) return;
    const slots = order.map((oid) => {
      const r = rows.current.get(oid)?.getBoundingClientRect();
      return { top: r?.top ?? 0, height: r?.height ?? 0 };
    });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
    setDrag({ id, from: idx, over: idx, dy: 0, startY: e.clientY, pointerId: e.pointerId, slots });
  };

  const moveDrag = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dy = e.clientY - drag.startY;
    const me = drag.slots[drag.from];
    const centre = me.top + me.height / 2 + dy;
    // The first other row whose midpoint is below the dragged row's centre decides where it lands.
    let landing = drag.slots.findIndex((s, i) => i !== drag.from && centre < s.top + s.height / 2);
    if (landing === -1) landing = drag.slots.length - 1;
    else if (landing > drag.from) landing -= 1;
    setDrag({ ...drag, dy, over: landing });
  };

  const end = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { from, over } = drag;
    setSettling(true);
    setDrag(null);
    move(from, over);
    requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
  };

  // Where every other row should sit while one is being dragged.
  const offsetFor = (idx: number): number => {
    if (!drag || idx === drag.from) return 0;
    const shift = drag.slots[drag.from].height + GAP;
    if (drag.from < drag.over && idx > drag.from && idx <= drag.over) return -shift;
    if (drag.from > drag.over && idx < drag.from && idx >= drag.over) return shift;
    return 0;
  };

  return (
    <ol className={clsx('order-list', drag && 'is-dragging', settling && 'settling')} aria-label="Drag or use the arrows to put these in order">
      {order.map((id, idx) => {
        const dragging = drag?.id === id;
        const shown = drag ? (dragging ? drag.over : idx + (offsetFor(idx) < 0 ? -1 : offsetFor(idx) > 0 ? 1 : 0)) : idx;
        return (
          <li
            key={id}
            ref={(el) => {
              if (el) rows.current.set(id, el);
              else rows.current.delete(id);
            }}
            className={clsx('order-item', dragging && 'dragging', !disabled && 'draggable')}
            style={{ transform: `translateY(${dragging ? drag.dy : offsetFor(idx)}px)` }}
            onPointerDown={(e) => start(e, id, idx, false)}
            onPointerMove={moveDrag}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <button
              type="button"
              className="order-grip"
              aria-label={`Reorder: ${byId.get(id)?.text}. Use the arrow keys to move.`}
              data-tip={disabled ? undefined : 'Drag to reorder'}
              disabled={disabled}
              onPointerDown={(e) => {
                e.stopPropagation();
                start(e, id, idx, true);
              }}
              onPointerMove={moveDrag}
              onPointerUp={end}
              onPointerCancel={end}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') { e.preventDefault(); move(idx, idx - 1); }
                if (e.key === 'ArrowDown') { e.preventDefault(); move(idx, idx + 1); }
              }}
            >
              ⋮⋮
            </button>
            <span className="order-num">{shown + 1}</span>
            <span className="grow">{byId.get(id)?.text}</span>
            {!disabled && (
              <span className="order-moves">
                <button type="button" className="btn sm light icon" aria-label="Move up" data-tip="Move up" disabled={idx === 0} onClick={() => move(idx, idx - 1)}>↑</button>
                <button type="button" className="btn sm light icon" aria-label="Move down" data-tip="Move down" disabled={idx === order.length - 1} onClick={() => move(idx, idx + 1)}>↓</button>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
