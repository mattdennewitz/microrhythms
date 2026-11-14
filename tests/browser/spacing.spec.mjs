import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

async function open(page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.MR));
  await page.locator('#btn-orbit').click();
}

async function spacing(page, value) {
  await page.locator('#sl-sep').fill(String(value));
  await page.waitForFunction(value => Math.abs(window.MR.view.sep - value) < 1e-5, value);
}

for (const value of [0.3, 1.25, 2.4]) {
  test(`disc spacing ${value}: every disc can be picked and edited`, async ({ page }) => {
    await open(page);
    await spacing(page, value);
    for (let index = 0; index < 7; index++) {
      // Find an exposed cell using the actual perspective and ray picker, then
      // exercise the real pointer handlers rather than calling edit actions.
      const cell = await page.evaluate(index => {
        const { view, stack } = window.MR, p = stack.plates[index];
        const b = view.canvas.getBoundingClientRect();
        for (let track = 0; track < p.tracks; track++) {
          for (let sector = 0; sector < p.steps; sector++) {
            const point = view.pp(view.plateX(p), p.rIn + (track + 0.5) * p.trackW,
              p.angleAt(0, false) + sector * 2 * Math.PI / p.steps);
            if (!point) continue;
            const x = b.left + point[0] * b.width / view.w, y = b.top + point[1] * b.height / view.h;
            if (document.elementFromPoint(x, y) !== view.canvas) continue;
            const hit = view.pick(x, y, 0, false);
            if (hit?.plate !== p || !hit.inAnnulus) continue;
            const key = hit.track * p.steps + hit.sector;
            return { x, y, key, on: p.chips.some(c => c.key === key) };
          }
        }
        return null;
      }, index);
      assert.ok(cell, `disc ${index} needs an exposed editable cell at spacing ${value}`);
      await page.mouse.click(cell.x, cell.y);
      assert.equal(await page.evaluate(() => window.MR.stack.selected), index);
      await page.keyboard.down('Shift');
      await page.mouse.click(cell.x, cell.y);
      await page.keyboard.up('Shift');
      assert.equal(await page.evaluate(({ index, key }) => window.MR.stack.plates[index].chips.some(c => c.key === key),
        { index, key: cell.key }), !cell.on);
    }
  });
}

for (const value of [0.37, 0.5]) {
  test(`overlapping discs at spacing ${value} stay selectable and keyboard-editable`, async ({ page }) => {
    await open(page);
    await spacing(page, value);
    for (let index = 0; index < 7; index++) {
      await page.getByRole('button', { name: `Select LYR.${index}`, exact: true }).click();
      assert.equal(await page.evaluate(() => window.MR.stack.selected), index);
      await page.locator('#stage').focus();
      const before = await page.evaluate(() => {
        const { stack, app } = window.MR;
        const key = app.cell.track * stack.sel.steps + app.cell.sector;
        return { key, on: stack.sel.chips.some(c => c.key === key) };
      });
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(({ index, key }) => window.MR.stack.plates[index].chips.some(c => c.key === key),
        { index, key: before.key }), !before.on);
    }
  });
}

test('camera modes preserve chosen disc spacing', async ({ page }) => {
  await open(page);
  await spacing(page, 0.73);
  for (const mode of ['SPLIT', 'ORBIT']) {
    await page.locator('#btn-mode').click();
    assert.deepEqual(await page.evaluate(() => ({ mode: window.MR.view.mode, spacing: window.MR.view.sepTarget })),
      { mode, spacing: 0.73 });
    await expect(page.locator('#sl-sep')).toHaveValue('0.73');
  }
});

test('disc spacing survives a downloaded project and a shared URL', async ({ page }) => {
  await open(page);
  await spacing(page, 2.17);
  const downloading = page.waitForEvent('download');
  await page.locator('#btn-save-project').click();
  const download = await downloading;
  const payload = await readFile(await download.path());
  assert.equal(JSON.parse(payload).view.sepTarget, 2.17);
  await spacing(page, 0.3);
  await page.locator('#project-input').setInputFiles({ name: 'spacing.json', mimeType: 'application/json', buffer: payload });
  await expect(page.locator('#sl-sep')).toHaveValue('2.17');
  assert.equal(await page.evaluate(() => window.MR.view.sep), 2.17);

  await page.locator('#btn-share').click();
  await page.waitForFunction(() => !window.MR.app.shareBusy && location.hash.startsWith('#mr2.'));
  const url = page.url();
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.MR));
  await expect(page.locator('#sl-sep')).toHaveValue('2.17');
  assert.equal(await page.evaluate(() => window.MR.view.sep), 2.17);
  assert.equal(await page.evaluate(() => window.MR.engine.playing), false);
});
