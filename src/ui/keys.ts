/* Window-level keyboard: shortcuts, undo/redo, play, and flight controls. */
import { useEffect } from 'react';
import { stack } from '../core/stack';
import { flight } from '../core/flight';
import { app } from '../app/controller';

const TEXT = ['text', 'search', 'email', 'number', 'password', 'url', 'tel'];

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented) return; // a control already handled this key
  const target = e.target as HTMLElement;
  const tag = target.tagName;
  // only text entry swallows shortcuts (a focused file input / button must not)
  if ((tag === 'INPUT' && TEXT.includes((target as HTMLInputElement).type)) || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable) return;
  const k = e.key;
  const F = flight;
  const mod = e.metaKey || e.ctrlKey || e.altKey;
  if (mod) F.keys.clear(); // macOS drops letter keyups while ⌘ is held: never leave thrust stuck
  // flight controls match physical keys (e.code) so any keyboard layout works
  const code = e.code || '';
  const letter = code.startsWith('Key') ? code.slice(3).toLowerCase() : k.toLowerCase();
  // single-key shortcuts: on globally, or (when turned off) only while the stack has focus
  const onStage = target === document.getElementById('stage');
  const keysLive = app.shortcuts || onStage;
  if (F.on && !mod && keysLive) {
    if (code.startsWith('Shift')) { F.keys.add('shift'); return; }
    if (letter.length === 1 && 'wasdqex'.includes(letter)) {
      e.preventDefault();
      if (letter !== 'x' && F.autopilot) { F.takeManual(); app.toast('manual — C re-engages autopilot'); }
      F.keys.add(letter);
      return;
    }
    if (e.repeat) return;
    if (letter === 'c') { app.toggleAutopilot(); return; }
    if (k === 'Escape') { app.toggleFlight(); return; }
  }
  if (e.repeat && k !== 'ArrowLeft' && k !== 'ArrowRight') return; // held keys don't re-toggle
  if (letter === 'f' && !mod && keysLive) { app.toggleFlight(); return; }
  if ((e.metaKey || e.ctrlKey) && (k === 'z' || k === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) app.redo(); else app.undo();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (k === ' ') {
    // Space plays from the page or the stack; on a focused control it does what that control does
    if (target === document.body || target === document.documentElement || onStage || (target as HTMLInputElement).type === 'range') {
      e.preventDefault();
      app.togglePlay();
    }
    return;
  }
  if (!keysLive) return;
  const sh = e.shiftKey;
  const S = stack;
  // physical keys (e.code), so Caps Lock and other layouts can't flip n/N, r/R, m/M
  if (letter === 'n') { if (sh) app.queuePhrase(); else app.newPhrase(); }
  else if (letter === 'k') app.keep();
  else if (letter === 'h') app.toggleHold();
  else if (letter === 's') app.toggleMode();
  else if (letter === 'o') app.toggleOrbit();
  else if (letter === 'p') app.togglePanel();
  else if (letter === 'r') { if (sh) app.regenAll(); else app.regen(); }
  else if (letter === 'm') { if (sh) app.mutateAll(); else app.toggleMute(); }
  else if (k === 'ArrowLeft' && target === document.body) app.select(S.selected - 1);
  else if (k === 'ArrowRight' && target === document.body) app.select(S.selected + 1);
  else if (/^Digit[1-9]$/.test(code) && +code.slice(5) <= S.plates.length) app.select(+code.slice(5) - 1);
}

function onKeyUp(e: KeyboardEvent) {
  const code = e.code || '';
  if (code.startsWith('Key')) flight.keys.delete(code.slice(3).toLowerCase());
  else if (code.startsWith('Shift')) flight.keys.delete('shift');
  else flight.keys.delete(e.key.toLowerCase());
}

export function useGlobalKeys() {
  useEffect(() => {
    const ac = new AbortController();
    window.addEventListener('keydown', onKeyDown, { signal: ac.signal });
    window.addEventListener('keyup', onKeyUp, { signal: ac.signal });
    window.addEventListener('blur', () => flight.keys.clear(), { signal: ac.signal }); // no stuck thrust
    return () => {
      ac.abort();
      flight.keys.clear();
    };
  }, []);
}
