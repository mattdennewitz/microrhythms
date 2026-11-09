import assert from 'node:assert/strict';
import { test } from 'node:test';
import { view } from '../src/core/view.ts';
import { stack } from '../src/core/stack.ts';

// A browser pinch/pan changes client coordinates, not the cell under a visible chip.
test('picking keeps the same plate and cell after viewport pan and CSS scaling', (t) => {
  const savedView = { ...view }, savedPlates = stack.plates;
  t.after(() => { Object.assign(view, savedView); stack.plates = savedPlates; });
  stack.createDefault();
  const plate = stack.plates[0];
  stack.plates = [plate];
  let bounds = { left: 0, top: 0, width: 400, height: 300 };
  Object.assign(view, {
    canvas: { getBoundingClientRect: () => bounds },
    w: 800, h: 600, dpr: 2, sep: 1.25,
    pos: [10, 0, 0], fwd: [-1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    F: 800, cx: 400, cy: 300, near: 0.2,
  });
  const track = 2, sector = 3;
  const r = plate.rIn + (track + 0.5) * plate.trackW;
  const a = plate.angleAt(0, false) + sector * 2 * Math.PI / plate.steps;
  const point = view.pp(view.plateX(plate), r, a);
  assert.ok(point);
  for (const rect of [bounds, { left: -95, top: -177, width: 400, height: 300 },
    { left: -40, top: 12, width: 600, height: 450 }]) {
    bounds = rect;
    const hit = view.pick(rect.left + point[0] * rect.width / view.w,
      rect.top + point[1] * rect.height / view.h, 0, false);
    assert.equal(hit?.plate, plate);
    assert.equal(hit?.track, track);
    assert.equal(hit?.sector, sector);
    assert.equal(hit?.inAnnulus, true);
  }
});
