/** Real headless-shell regression: a screenshot taken shortly after the DOM
 * changed, following ticks that requested no screenshot, can show an older
 * drawn frame. captureFrame must return the current frame. No user cards or
 * media are needed.
 *
 * Measured on chrome-headless-shell 152 at 1920x1080: fade in over 10 ticks,
 * hold 20 more ticks, first screenshot centre alpha 77 (plain) / 102 (SVG
 * noise), second screenshot 255. Holding 150 ticks did not reproduce, which is
 * why a 64x64 / 150-tick version of this test passed without the fix.
 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { PNG } from 'pngjs';
import { openBakery } from '../server/bakery/index.mjs';
import { captureFrame } from '../server/bakery/capture-frame.mjs';

process.env.PROMPTCUT_ROLE = 'prerender';
const port = 5195;
const server = await createServer({ configFile: 'vite.prerender.config.ts', server: { host: '127.0.0.1', port, strictPort: true } });
const project = { id: 'stale-capture', width: 1920, height: 1080, fps: 30, duration: 1, themeId: 'default', tracks: [], media: [] };
const url = `http://127.0.0.1:${port}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;
const SHOT = { format: 'png', optimizeForSpeed: true };
const HOLDS = [5, 10, 20, 150];
const centreAlpha = buf => PNG.sync.read(buf).data[(540 * 1920 + 960) * 4 + 3];

/** A card-like fadeIn: opacity rises over 10 ticks and then holds at 1 for
 *  `hold` ticks, none of which request a screenshot. */
async function fadeThenHold(bakery, hold) {
  await bakery.page.evaluate(() => {
    document.getElementById('stale-probe')?.remove();
    const probe = document.createElement('div');
    probe.id = 'stale-probe';
    probe.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#ece6da;opacity:0;isolation:isolate';
    document.body.append(probe);
  });
  for (let k = 1; k <= 10 + hold; k++) {
    if (k <= 10) {
      await bakery.page.evaluate(o => {
        const probe = document.getElementById('stale-probe');
        if (o < 1) probe.style.opacity = String(o); else probe.style.removeProperty('opacity');
      }, k / 10);
    }
    await bakery.beginFrame();
  }
  return bakery.page.evaluate(() => getComputedStyle(document.getElementById('stale-probe')).opacity);
}

let bakery;
const evidence = [];
try {
  await server.listen();
  bakery = await openBakery({ url });
  await bakery.page.setViewport({ width: 1920, height: 1080 });
  await bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

  for (const hold of HOLDS) {
    const domOpacity = await fadeThenHold(bakery, hold);
    const raw = await bakery.beginFrame({ screenshot: SHOT });
    const unprimed = centreAlpha(Buffer.from(raw.screenshotData, 'base64'));
    await fadeThenHold(bakery, hold);
    const primed = centreAlpha(await captureFrame(bakery, SHOT));
    evidence.push({ hold, domOpacity, unprimed, primed });
  }
  console.log(JSON.stringify(evidence));
  for (const row of evidence) {
    assert.equal(row.domOpacity, '1');
    assert.equal(row.primed, 255, `captureFrame returned an older drawn frame after holding ${row.hold} ticks (alpha ${row.primed})`);
  }
  if (evidence.every(row => row.unprimed === 255)) {
    console.warn('WARN this Chrome did not reproduce the stale screenshot; the primed assertions still passed');
  } else {
    console.log(`reproduced stale unprimed screenshots at holds ${evidence.filter(r => r.unprimed !== 255).map(r => `${r.hold} (alpha ${r.unprimed})`).join(', ')}`);
  }
  console.log('PASS captureFrame returns the current frame after uncaptured ticks');
} finally {
  await bakery?.close();
  await server.close();
}
