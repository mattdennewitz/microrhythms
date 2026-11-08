/* Bootstrap + frame loop. */
(function (MR) {
  'use strict';

  function boot() {
    MR.stack.createDefault();
    MR.sounds.initBuiltins();
    MR.view.init(document.getElementById('stage'));
    MR.ui.init();

    // Debug / test hook.
    window.MR_DEBUG = {
      get triggers() { return MR.engine.stats.triggers; },
      get scheduled() { return MR.engine.stats.scheduled; },
      get dropped() { return MR.engine.stats.dropped; },
      get voices() { return MR.engine.voices; },
      get playing() { return MR.engine.playing; },
      get sounds() { return MR.sounds.list.map((s) => ({ id: s.id, name: s.name, builtin: s.builtin, dur: s.buffer.duration })); },
      plates: () => MR.stack.plates.map((p) => ({ name: p.name, chips: p.chips.length, sources: [...p.sourceIds], fires: p.fireCount })),
      fps: 0,
      drawMs: 0,
    };

    let last = performance.now(), frames = 0, acc = 0;
    function frame(now) {
      const E = MR.engine, V = MR.view;
      const tv = E.playing ? E.visualTime() : 0;

      // consume due visual events → flashes + per-plate counters
      // (events are grouped per plate per tick, so not globally sorted)
      if (E.events.length) {
        const pending = [];
        for (const ev of E.events) {
          if (ev.t <= tv) {
            if (ev.t > ev.chip.lastFire) ev.chip.lastFire = ev.t;
            if (ev.t > ev.plate.lastFire) ev.plate.lastFire = ev.t;
            ev.plate.fireCount++;
          } else pending.push(ev);
        }
        E.events = pending;
      }

      V.updateCamera(now / 1000);
      E.updateSpace(V);
      E.readMeters();
      const d0 = performance.now();
      V.draw(tv, E.playing, now / 1000);
      window.MR_DEBUG.drawMs = window.MR_DEBUG.drawMs * 0.9 + (performance.now() - d0) * 0.1;
      MR.ui.updateHud(tv);

      frames++; acc += now - last; last = now;
      if (acc > 1000) { window.MR_DEBUG.fps = Math.round(frames * 1000 / acc); frames = 0; acc = 0; }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.MR);
