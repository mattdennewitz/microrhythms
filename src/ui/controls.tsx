/* Small shared controls: slider, segmented row, toggle button, tap / long-press. */
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

export interface SliderProps {
  /** Used for the input id (`sl-<key>`). */
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  fmt: (v: number) => string;
  onInput: (v: number) => void;
  /** Called once at the start of each gesture (drag, arrows, PageUp, assistive tech). */
  onStart?: () => void;
  /** Double-click resets to this value. */
  reset?: number;
  /** Map between the stored value and the slider position (index or log scales). */
  toSlider?: (v: number) => number;
  fromSlider?: (s: number) => number;
  /** Show MIXED instead of a value (several plates disagree). */
  mixed?: boolean;
}

const ident = (v: number) => v;

export function Slider(o: SliderProps) {
  const toSlider = o.toSlider || ident, fromSlider = o.fromSlider || ident;
  // The thumb stays where the user put it: a value that round-trips through a
  // rounding fromSlider/toSlider pair would otherwise jump under the pointer.
  const [raw, setRaw] = useState(() => toSlider(o.value));
  const emitted = useRef(o.value);
  if (o.value !== emitted.current) {
    emitted.current = o.value;
    setRaw(toSlider(o.value));
  }
  const mixed = !!o.mixed;

  // one undo step per gesture, whatever the input method (drag, arrows, PageUp, AT)
  const gesture = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // React's onChange is the native `input` event; the native `change` event ends a gesture
    const el = input.current;
    if (!el) return;
    const end = () => { gesture.current = false; };
    el.addEventListener('change', end);
    return () => el.removeEventListener('change', end);
  }, []);
  const start = () => { if (o.onStart) o.onStart(); };
  const set = (v: number) => {
    emitted.current = v;
    o.onInput(v);
  };
  // what's shown is also what assistive tech announces (not the raw index / log value)
  const text = mixed ? 'MIXED' : o.fmt(o.value);
  const id = 'sl-' + o.id;
  return (
    <div className={'slider' + (mixed ? ' mixed' : '')}>
      <label htmlFor={id}>{o.label}</label>
      <input
        ref={input}
        type="range" id={id} min={o.min} max={o.max} step={o.step} value={raw}
        aria-valuetext={text}
        onPointerDown={() => { gesture.current = true; start(); }}
        onChange={(e) => {
          if (!gesture.current) { gesture.current = true; start(); }
          const s = parseFloat(e.target.value);
          setRaw(s);
          set(fromSlider(s));
        }}
        onDoubleClick={() => {
          if (o.reset != null) { start(); setRaw(toSlider(o.reset)); set(o.reset); }
        }}
      />
      <output htmlFor={id}>{text}</output>
    </div>
  );
}

/** Segmented buttons: exactly one is on. */
export function Seg<T extends string | number>({ items, value, onPick, className, id, title }: {
  items: Array<{ label: string; value: T; title?: string }>;
  value: T;
  onPick: (v: T) => void;
  className?: string;
  id?: string;
  title?: string;
}) {
  return (
    <div className={'row seg' + (className ? ' ' + className : '')} id={id} title={title}>
      {items.map((it) => (
        <Toggle key={String(it.value)} on={it.value === value} title={it.title} onClick={() => onPick(it.value)}>{it.label}</Toggle>
      ))}
    </div>
  );
}

/** A button whose look and aria-pressed follow `on`. */
export function Toggle({ on, className, children, ...rest }: { on: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={(className ? className + ' ' : '') + (on ? 'on' : '')} aria-pressed={on ? 'true' : 'false'}>
      {children}
    </button>
  );
}

/** Tap vs long-press (≥450 ms). Keyboard activation counts as a tap. */
export function usePressable(onTap: (e: MouseEvent<HTMLButtonElement>) => void, onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longFired = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const clear = () => clearTimeout(timer.current);
  return {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      longFired.current = false;
      clear();
      timer.current = setTimeout(() => { longFired.current = true; onLong(); }, 450);
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: () => { clear(); longFired.current = false; },
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      clear();
      if (e.detail === 0) { longFired.current = false; onTap(e); return; } // keyboard activation
      if (longFired.current) { longFired.current = false; return; }
      onTap(e);
    },
  };
}
