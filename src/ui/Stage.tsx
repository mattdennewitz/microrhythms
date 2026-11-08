/* The stack canvas: orbit/zoom by pointer, pick and edit chips, keyboard cell cursor.
 * The canvas is focusable: arrows move a cell cursor on the selected plate
 * (PageUp/PageDown change plate), Enter toggles a chip, Shift+Enter cycles its FX,
 * [ ] orbit, - = zoom, 0 resets the view. In flight, arrows look around. */
import { useEffect, useRef } from 'react';
import { stack } from '../core/stack';
import { engine } from '../core/engine';
import { history } from '../core/history';
import { flight } from '../core/flight';
import { view } from '../core/view';
import { clamp } from '../core/util';
import { app } from '../app/controller';
import { notify } from '../app/store';
import { startLoop } from '../app/loop';

export function Stage() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current!;
    startLoop(cv);
    const V = view;
    const ac = new AbortController();
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) =>
      cv.addEventListener(type, fn, { signal: ac.signal, ...opts });

    // ---- pointer: drag to orbit (look, in flight), click to select / edit
    let down: { x: number; y: number; lx: number; ly: number; yaw: number; pitch: number; moved: boolean } | null = null;
    on('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, yaw: V.dragYaw, pitch: V.dragPitch, moved: false };
      cv.setPointerCapture(e.pointerId);
    });
    on('pointermove', (e) => {
      if (down) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) { down.moved = true; cv.classList.add('dragging'); }
        if (flight.on) {
          flight.look((e.clientX - down.lx) * 0.004, -(e.clientY - down.ly) * 0.004);
          down.lx = e.clientX; down.ly = e.clientY;
          return;
        }
        V.dragYaw = down.yaw - dx * 0.005;
        V.dragPitch = down.pitch + dy * 0.004;
        return;
      }
      const hit = V.pick(e.clientX, e.clientY, engine.visualTime(), engine.playing);
      V.hover = hit && hit.chip ? { plate: hit.plate, chip: hit.chip } : null;
      V.hoverHit = hit;
      cv.classList.toggle('pointing', !!hit);
    });
    on('pointerup', (e) => {
      if (!down) return;
      cv.classList.remove('dragging');
      if (!down.moved) {
        const hit = V.pick(e.clientX, e.clientY, engine.visualTime(), engine.playing);
        if (hit) {
          if (e.altKey && hit.chip) {
            history.push('chip fx');
            const fx = hit.plate.cycleFx(hit.chip);
            app.toast(`${hit.plate.name} · T${hit.track} S${hit.sector} → ${fx || 'no fx'}`);
          } else if (e.shiftKey && hit.inAnnulus) {
            history.push('chip');
            const added = hit.plate.toggleCell(hit.track, hit.sector);
            app.toast(`${hit.plate.name} · chip ${added ? 'added' : 'removed'} at T${hit.track} S${hit.sector}`);
          }
          app.select(hit.plate.index);
        }
      }
      down = null;
    });
    on('pointercancel', () => { down = null; cv.classList.remove('dragging'); });
    on('pointerleave', () => { if (!down) V.hover = null; });
    on('wheel', (e) => {
      e.preventDefault();
      if (flight.on) {
        flight.R = clamp(flight.R * Math.exp(-e.deltaY * 0.001), 0.06, 0.8);
        notify(); // the SENSOR slider follows
        return;
      }
      V.zoom = clamp(V.zoom * Math.exp(e.deltaY * 0.001), 0.45, 2.2);
    }, { passive: false });
    on('dblclick', () => { if (!flight.on) { V.dragYaw = 0; V.dragPitch = 0; V.zoom = 1; } });

    // ---- keyboard cell cursor
    on('focus', () => app.syncCell(true));
    on('blur', () => app.clearCell());
    on('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const c = app.cell;
      let handled = true;
      if (flight.on && e.key.startsWith('Arrow')) {
        const d = 0.06;
        if (e.key === 'ArrowLeft') flight.look(-d, 0); else if (e.key === 'ArrowRight') flight.look(d, 0);
        else if (e.key === 'ArrowUp') flight.look(0, d); else flight.look(0, -d);
      }
      else if (e.key === 'ArrowLeft') { c.sector--; app.syncCell(true); }
      else if (e.key === 'ArrowRight') { c.sector++; app.syncCell(true); }
      else if (e.key === 'ArrowUp') { c.track++; app.syncCell(true); }
      else if (e.key === 'ArrowDown') { c.track--; app.syncCell(true); }
      else if (e.key === 'PageUp') { app.select(stack.selected + 1); app.syncCell(true); }
      else if (e.key === 'PageDown') { app.select(stack.selected - 1); app.syncCell(true); }
      else if (e.key === 'Enter') {
        const p = stack.sel;
        const chip = p.chips.find((x) => x.key === c.track * p.steps + c.sector);
        if (e.shiftKey) {
          if (chip) {
            history.push('chip fx');
            const fx = p.cycleFx(chip);
            app.announce(`FX ${fx || 'none'}`);
            app.toast(`${p.name} · T${c.track} S${c.sector} → ${fx || 'no fx'}`);
          }
        } else {
          history.push('chip');
          const added = p.toggleCell(c.track, c.sector);
          app.toast(`${p.name} · chip ${added ? 'added' : 'removed'} at T${c.track} S${c.sector}`);
          app.announce(`chip ${added ? 'added' : 'removed'}`);
        }
        app.syncCell(false);
      }
      else if (e.key === '[') V.dragYaw -= 0.08;
      else if (e.key === ']') V.dragYaw += 0.08;
      else if (e.key === '-') V.zoom = clamp(V.zoom * 1.1, 0.45, 2.2);
      else if (e.key === '=' || e.key === '+') V.zoom = clamp(V.zoom / 1.1, 0.45, 2.2);
      else if (e.key === '0') { V.dragYaw = 0; V.dragPitch = 0; V.zoom = 1; }
      else handled = false;
      // the window-level shortcut handler must not see keys the stack used
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });
    return () => ac.abort();
  }, []);

  return (
    <canvas id="stage" ref={ref} tabIndex={0} role="application" aria-roledescription="rhythm stack"
      aria-label="Orbital stack. Arrow keys move a cell cursor on the selected plate, Page Up and Page Down change plate, Enter adds or removes a chip, Shift+Enter cycles its FX, square brackets orbit, minus and equals zoom, 0 resets the view. In flight, arrows look around."
      aria-describedby="hud-tr" />
  );
}
