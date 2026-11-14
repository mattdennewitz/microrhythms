import assert from 'node:assert/strict';
import { test } from '@playwright/test';

async function open(page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.MR));
  await page.evaluate(() => {
    const { app, flight, view } = window.MR;
    flight.on = false;
    app.setPanelHidden(false);
    view.autoOrbit = false;
    view.orbitPhase = 0;
  });
}

test('real Alt-click edits the rendered displaced key 0, not nominal key 15', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const point = await page.evaluate(async () => {
    const { view, stack } = window.MR, p = stack.plates[6];
    Object.assign(p, {
      steps: 16, tracks: 1, micro: 1, swing: 0.5, phaseStep: 1, onBeat: 0,
      dir: 1, density: 1, fxDensity: 0, grainMs: 40, phiFrozen: 0,
    });
    p.overrides.clear(); p.fxOverrides.clear();
    for (let key = 0; key < 16; key++) p.overrides.set(key, true);
    p.generate();
    p.phaseStep = 1;
    // Deterministic supported jitter: key 0 is rendered across the nominal seam.
    p.chips.forEach(c => { c.uMicro = c.key === 0 ? 0.1 : 0.5; });
    p.refresh();
    const deg = Math.PI / 180;
    view.dragYaw = Math.PI / 2 - 44 * deg;
    view.dragPitch = -(2.5 + Math.sin(1) * 2.5) * deg;
    await new Promise(requestAnimationFrame);
    const chip = p.chips.find(c => c.key === 0);
    const q = view.pp(view.plateX(p), chip.radius, chip.angle);
    if (!q) throw new Error('Rendered chip must be in front of the camera');
    const bounds = view.canvas.getBoundingClientRect();
    const x = bounds.left + q[0] * bounds.width / view.w;
    const y = bounds.top + q[1] * bounds.height / view.h;
    const nominal = ((Math.round(chip.angle * p.steps / (2 * Math.PI)) % p.steps) + p.steps) % p.steps;
    if (document.elementFromPoint(x, y) !== view.canvas) throw new Error('Chip must be exposed to real input');
    return { x, y, nominal };
  });
  assert.equal(point.nominal, 15, 'fixture must reproduce the displaced nominal neighbor');
  await page.keyboard.down('Alt');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Alt');
  assert.deepEqual(await page.evaluate(() => {
    const p = window.MR.stack.plates[6];
    return { key0: p.chips.find(c => c.key === 0).fx, key15: p.chips.find(c => c.key === 15).fx };
  }), { key0: 'ratchet', key15: null });
});

test('a clipped foreground plate cannot intercept a real click on a visible flight chip', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const point = await page.evaluate(async () => {
    const { view, stack, flight, app } = window.MR;
    view.sep = view.sepTarget = 1;
    stack.plates.forEach((p, i) => { p.x = -2 - i; });
    for (const [index, x] of [[0, 0.01], [1, 0.15]]) {
      const p = stack.plates[index];
      Object.assign(p, { x, rIn: 0.4, rOut: 0.8, steps: 4, tracks: 1,
        micro: 0, swing: 0, fxDensity: 0, phiFrozen: Math.PI / 2 });
      p.overrides.clear(); p.fxOverrides.clear();
      for (let key = 0; key < 4; key++) p.overrides.set(key, key === 0);
      p.generate();
    }
    Object.assign(flight, { on: true, autopilot: false, pos: [0, 0.6, 0],
      vel: [0, 0, 0], yaw: 0, pitch: 0 });
    flight.keys.clear();
    app.select(6);
    app.syncAll();
    await new Promise(requestAnimationFrame);
    const q = view.project(0.15, 0.6, 0);
    if (view.near !== 0.03 || view.project(0.01, 0.6, 0) !== null || !q) {
      throw new Error('Fixture must clip the foreground and project the farther chip');
    }
    const bounds = view.canvas.getBoundingClientRect();
    return { x: bounds.left + q[0] * bounds.width / view.w,
      y: bounds.top + q[1] * bounds.height / view.h };
  });
  await page.mouse.click(point.x, point.y);
  assert.equal(await page.evaluate(() => window.MR.stack.selected), 1);
});

for (const viewport of [{ width: 740, height: 400 }, { width: 820, height: 1180 }]) {
  test(`camera uses the real unobscured panel region at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page);
    await page.waitForFunction(() => {
      const { view } = window.MR, b = view.canvas.getBoundingClientRect();
      const panel = document.getElementById('panel').getBoundingClientRect();
      const x = b.left + view.cx * b.width / view.w;
      const y = b.top + view.cy * b.height / view.h;
      const expectedX = (b.left + (innerWidth <= 760 ? b.right : panel.left)) / 2;
      const expectedY = (b.top + (innerWidth <= 760 ? panel.top : b.bottom)) / 2;
      return Math.abs(x - expectedX) < 0.5 && Math.abs(y - expectedY) < 0.5;
    });
    const layout = await page.evaluate(() => {
      const { view } = window.MR, b = view.canvas.getBoundingClientRect();
      const panel = document.getElementById('panel').getBoundingClientRect();
      const x = b.left + view.cx * b.width / view.w;
      const y = b.top + view.cy * b.height / view.h;
      return { x, y, panelLeft: panel.left, panelTop: panel.top,
        unobscured: document.elementFromPoint(x, y) === view.canvas };
    });
    assert.equal(layout.unobscured, true);
    if (viewport.width <= 760) {
      assert.ok(Math.abs(layout.x - viewport.width / 2) < 0.5);
      assert.ok(Math.abs(layout.y - layout.panelTop / 2) < 0.5);
    } else {
      assert.ok(Math.abs(layout.x - layout.panelLeft / 2) < 0.5);
      assert.ok(Math.abs(layout.y - viewport.height / 2) < 0.5);
    }
    await page.evaluate(() => window.MR.app.setPanelHidden(true));
    await page.waitForFunction(() => {
      const { view } = window.MR;
      return Math.abs(view.cx - view.w / 2) < 0.5 && Math.abs(view.cy - view.h / 2) < 0.5;
    });
  });
}

test('real Shift-click still inserts an empty nominal cell', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const cell = await page.evaluate(async () => {
    const { view, stack } = window.MR, p = stack.plates[6];
    p.micro = p.swing = 0;
    p.overrides.clear();
    for (let key = 0; key < p.steps * p.tracks; key++) p.overrides.set(key, false);
    p.generate();
    await new Promise(requestAnimationFrame);
    const bounds = view.canvas.getBoundingClientRect();
    for (let track = 0; track < p.tracks; track++) {
      for (let sector = 0; sector < p.steps; sector++) {
        const q = view.pp(view.plateX(p), p.rIn + (track + 0.5) * p.trackW,
          p.angleAt(0, false) + sector * 2 * Math.PI / p.steps);
        if (!q) continue;
        const x = bounds.left + q[0] * bounds.width / view.w;
        const y = bounds.top + q[1] * bounds.height / view.h;
        if (document.elementFromPoint(x, y) !== view.canvas) continue;
        const hit = view.pick(x, y, 0, false);
        if (hit?.plate === p && hit.inAnnulus && !hit.chip) return { x, y, key: hit.track * p.steps + hit.sector };
      }
    }
    throw new Error('Fixture needs an exposed empty cell');
  });
  await page.keyboard.down('Shift');
  await page.mouse.click(cell.x, cell.y);
  await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(key => window.MR.stack.plates[6].chips.some(c => c.key === key), cell.key), true);
});
