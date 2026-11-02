/**
 * Real-device self-check for the web operation module. **Requires network, launches a real Chrome**,
 * so it is not included in npm test (that suite runs in 6s; adding this makes it take minutes). Run
 * manually after modifying server/web/:
 *
 *     node scripts/web-check.mjs [url]
 *
 * It verifies the half that unit tests cannot: whether bundled Chrome can start, whether the
 * offscreen window stays off screen, whether screenshots and manifests are generated, whether hit
 * testing is accurate on real pages, and whether the window can be moved out and hidden back.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowser, closeBrowser, showWindow, hideWindow } from '../server/web/browser.mjs';
import { captureView } from '../server/web/view.mjs';
import { resolveAt } from '../server/web/hit.mjs';
import * as session from '../server/web/session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ARG = process.argv[2] || 'https://developer.mozilla.org/en-US/docs/Web/API/fetch';

let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Keep consistent with vite-plugin-web.ts: pass paths explicitly, do not rely on PUPPETEER_CACHE_DIR inheritance */
async function bundledChrome() {
  const { findBundledChrome } = await import('../server/vite-plugin-web.ts').catch(() => ({}));
  if (findBundledChrome) return findBundledChrome(ROOT);
  // Search manually when .ts cannot be imported directly
  const fs = await import('node:fs');
  const root = process.env.PUPPETEER_CACHE_DIR
    ?? path.join(ROOT, 'desktop', 'src-tauri', 'runtime', 'chrome');
  const dir = path.join(root, 'chrome');
  if (!fs.existsSync(dir)) return undefined;
  const build = fs.readdirSync(dir).filter((d) => d.startsWith('win')).sort().pop();
  if (!build) return undefined;
  const exe = path.join(dir, build, 'chrome-win64', 'chrome.exe');
  return fs.existsSync(exe) ? exe : undefined;
}

const t0 = Date.now();
try {
  const exe = await bundledChrome();
  console.log(`
── 1. Launch browser ──`);
  console.log(`  Chrome: ${exe || '(bundled copy not found, using puppeteer\'s own cache)'}`);
  // Use a temporary profile, do not touch out/web-profile: that copy is the user's login state,
  // and the self-check should not occupy it (occupying it prevents a running dev server from launching
  // the browser, and cookies produced by the self-check should not be left behind)
  const inst = await getBrowser({ dataDir: null, executablePath: exe });
  ok(!!inst.page, 'instance is up', await inst.browser.version());

  const { bounds } = await inst.cdp.send('Browser.getWindowForTarget');
  ok(bounds.left < 0, 'window is off-screen', `left=${bounds.left}`);

  console.log(`
── 2. Open page + screenshot and manifest ──`);
  const opened = await session.open(inst.page, URL_ARG);
  ok(opened.ok, 'navigation succeeded', opened.url);
  ok(!!opened.__image?.base64, 'screenshot captured', `${Math.round((opened.__image?.base64.length || 0) / 1024)} KB webp`);
  ok(opened.image.width <= 800 && opened.image.height <= 800,
    'long edge at most 800', `${opened.image.width}x${opened.image.height}`);
  const vp = inst.page.viewport();
  const ratioImg = opened.image.width / opened.image.height;
  const ratioVp = vp.width / vp.height;
  ok(Math.abs(ratioImg - ratioVp) < 0.02, 'aspect ratio matches the viewport (proportional scaling)',
    `image ${ratioImg.toFixed(3)} / viewport ${ratioVp.toFixed(3)}`);
  ok(Array.isArray(opened.clickable) && opened.clickable.length > 0,
    'clickable manifest returned', `${opened.clickable.length} items${opened.omitted ? `, ${opened.omitted} omitted` : ''}`);
  const listBytes = JSON.stringify(opened.clickable).length;
  console.log(`     manifest ${listBytes} chars ≈ ${Math.round(listBytes / 4)} tokens`);

  console.log(`
── 3. Hit test ──`);
  const target = opened.clickable.find((c) => c.n && c.n.length > 2 && c.b[1] > 0);
  if (!target) { ok(false, 'no testable target element found'); }
  else {
    const cx = Math.round((target.b[0] + target.b[2]) / 2);
    const cy = Math.round((target.b[1] + target.b[3]) / 2);
    const hit = await resolveAt(inst.page, cx, cy);
    ok(hit.ok && hit.pick.u === target.u, 'center point resolves back to the same uid',
      `reported (${cx},${cy}) → ${hit.ok ? hit.pick.u : hit.reason}, target ${target.u} «${target.n}»`);

    const bad = await resolveAt(inst.page, cx, cy, { expect: 'this name is definitely not on the page' });
    ok(!bad.ok && bad.reason === 'expect_mismatch',
      'rejects when expect does not match, does not gamble for the model', `reason=${bad.reason}`);

    const far = await resolveAt(inst.page, 5, opened.image.height - 5);
    ok(!far.ok, 'empty corner area correctly misses', `reason=${far.reason}`);
  }

  console.log(`
── 4. Read body text ──`);
  const read = await session.read(inst.page, { limit: 500 });
  ok(read.ok && read.text.length > 50, 'body text retrieved', `${read.total} chars total`);
  ok(!read.__image, 'reading body text returns no image (saves tokens)');

  console.log(`
── 5. Scroll ──`);
  const scrolled = await session.scroll(inst.page, { dy: 800 });
  ok(scrolled.ok && !!scrolled.__image, 'after scrolling, a new image and manifest are returned automatically');

  console.log(`
── 6. Window handoff ──`);
  await showWindow(inst);
  const shown = await inst.cdp.send('Browser.getWindowForTarget');
  ok(shown.bounds.left >= 0, 'can be moved on-screen and handed to the user', `left=${shown.bounds.left}`);
  await hideWindow(inst);
  const hidden = await inst.cdp.send('Browser.getWindowForTarget');
  ok(hidden.bounds.left < 0, 'can be hidden off-screen again', `left=${hidden.bounds.left}`);
} catch (e) {
  fail++;
  console.log(`\n  ✗ threw an exception: ${e.stack || e.message}`);
} finally {
  await closeBrowser();
}

console.log(`\n${fail === 0 ? 'All passed' : `${fail} failed`}, ${pass} passed / ${pass + fail} items, took ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
process.exit(fail === 0 ? 0 : 1);
