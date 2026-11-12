/**
 * Browser probe for Issue #14: deterministic representative-frame preview thumbnails in the
 * Classic mode Animation panel (`AnimationsSection`).
 *
 * Usage:
 *   node scripts/probes/animation-thumbs-probe.mjs [--port 5230] [--origin http://127.0.0.1:N] [--keep]
 *
 * Verifies:
 *   1. Classic mode editor (`/?editor&nosetup=1`) opens the Animation panel (`[data-pc-rail="animations"]`).
 *   2. Overview group boxes render non-blank representative-frame thumbnails (`ThumbTile` + `AnimationThumb`).
 *   3. Every tile across all 6 groups (`user-cards`, `magicui`, `native`, `parts`, `lottie`, `particles`)
 *      resolves `data-pc-thumb` to `"dom"` or `"img"` (never `"fallback"`), with `score > 0` and
 *      verified non-blank rendered visuals (rasterized pixel alpha check for `img` mode, visible
 *      rendered geometry/image check for `dom` mode).
 *   4. Entrance (`mu-blur-fade`, `checklist`, `focus-card`), short decaying pulse (`av-pulse`), and
 *      Lottie (`lottie-adrock`) animations select non-empty representative timestamps.
 *   5. Hovering a card still mounts live `[data-pc="preview"]` and unmounts cleanly on mouseleave,
 *      with `window.__pcExportMs === undefined` on the editor main document.
 *   6. Reloading the editor and recomputing thumbnails from scratch produces 100% identical
 *      `(mode, t, phase, score)` across runs.
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer } from '../lib/dev-server.mjs';

const PORT = Number(flagArg('port', 5230));
if (!flagArg('origin', null) && PORT >= 5190 && PORT <= 5192) {
  throw new Error(`Port ${PORT} is reserved for the user's live PromptCut instance (5190-5192)`);
}
const GIVEN_ORIGIN = flagArg('origin', null);
const SHOTS_DIR = flagArg('shots', null);
const KEEP = process.argv.includes('--keep');

const EXPECTED_GROUPS = ['user-cards', 'magicui', 'native', 'parts', 'lottie', 'particles'];

const results = [];
const check = (name, ok, extra = {}) => {
  const row = { check: name, ok: !!ok, ...extra };
  results.push(row);
  console.log(JSON.stringify(row));
  return !!ok;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const val = await fn();
      if (val) return val;
    } catch {
      /* Retry until timeout */
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`);
    }
    await sleep(120);
  }
}

/** Open the Classic mode Animation panel and ensure the overview is shown with all card tiers enabled. */
async function openAnimationsOverview(page) {
  await waitFor(() => page.$('[data-pc-rail="animations"]'), 30_000, 'animations rail button');
  await page.evaluate(() => {
    localStorage.setItem(
      'pc.cardVisibility.v1',
      JSON.stringify({
        base: true,
        groups: { native: true, magicui: true, asset: true },
        custom: true,
        project: true,
      }),
    );
  });

  const ensureOpen = async () => {
    const state = await page.evaluate(() => {
      const rail = document.querySelector('[data-pc-rail="animations"]');
      const drawer = document.querySelector('[data-pc="left-drawer"]');
      const sec = document.querySelector('[data-pc="animations"]');
      return {
        on: !!rail && rail.classList.contains('is-on'),
        drawerOpen: !!drawer && drawer.getClientRects().length > 0,
        secShown: !!sec && sec.getClientRects().length > 0,
      };
    });
    if (!state.on || !state.drawerOpen || !state.secShown) {
      await page.click('[data-pc-rail="animations"]');
      await sleep(200);
    }
  };

  await ensureOpen();
  await ensureOpen();

  // If a group was previously open, return to the overview first.
  const closedGroup = await page.evaluate(() => {
    const chip = document.querySelector('[data-pc="animations"] [data-pc-chip="all"]');
    if (chip instanceof HTMLElement) {
      chip.click();
      return true;
    }
    return false;
  });
  if (closedGroup) await sleep(180);
}

async function openAnimationGroup(page, groupId) {
  await openAnimationsOverview(page);
  await waitFor(
    () => page.$(`[data-pc="animations"] [data-pc-group="${groupId}"]`),
    15_000,
    `group box ${groupId}`,
  );
  await page.evaluate((gid) => {
    const box = document.querySelector(`[data-pc="animations"] [data-pc-group="${gid}"]`);
    if (!box) throw new Error(`Missing group box ${gid}`);
    box.scrollIntoView({ block: 'center' });
    const head = box.querySelector('.pc-lib-group-head');
    if (head instanceof HTMLElement) head.click();
    else if (box instanceof HTMLElement) box.click();
  }, groupId);
  await waitFor(
    () => page.$(`[data-pc="animations"] [data-pc-open-group="${groupId}"]`),
    15_000,
    `open group ${groupId}`,
  );
}

/** Scroll the visible `.pc-lib-scroll` inside `[data-pc="animations"]` until all `.pc-anim-thumb` resolve. */
async function scrollAndCollectThumbs(page, scopeSelector, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  await page.evaluate((sel) => {
    const scroller = [...document.querySelectorAll('[data-pc="animations"] .pc-lib-scroll')]
      .find((el) => el.getClientRects().length > 0);
    if (scroller) scroller.scrollTop = 0;
    void sel;
  }, scopeSelector);

  for (;;) {
    const status = await page.evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return { foundRoot: false, total: 0, ready: 0 };
      const thumbs = [...root.querySelectorAll('.pc-anim-thumb')];
      const ready = thumbs.filter((el) => el.getAttribute('data-pc-thumb-ready') === '1').length;
      const scroller = [...document.querySelectorAll('[data-pc="animations"] .pc-lib-scroll')]
        .find((el) => el.getClientRects().length > 0);
      if (scroller && ready < thumbs.length) {
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (maxScroll > 0) {
          if (scroller.scrollTop >= maxScroll - 2) {
            scroller.scrollTop = 0;
          } else {
            scroller.scrollTop = Math.min(maxScroll, scroller.scrollTop + Math.max(140, scroller.clientHeight * 0.6));
          }
        }
      }
      return { foundRoot: true, total: thumbs.length, ready };
    }, scopeSelector);

    if (status.foundRoot && status.total > 0 && status.ready === status.total) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for thumbnails in ${scopeSelector}: ${JSON.stringify(status)}`);
    }
    await sleep(160);
  }

  // Inspect every resolved thumbnail in this container, including pixel alpha verification on `img` thumbnails
  // and visible leaf element / rasterized image verification on `dom` thumbnails.
  return page.evaluate(async (sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = 32;
    probeCanvas.height = 32;
    const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

    const inspectImg = async (img) => {
      if (!img.complete) {
        await new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 1500);
        });
      }
      if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0 || !probeCtx) {
        return { validImg: false, nonTransparentPx: 0 };
      }
      const cw = Math.max(1, Math.min(img.naturalWidth, 320));
      const ch = Math.max(1, Math.min(img.naturalHeight, 180));
      if (probeCanvas.width !== cw || probeCanvas.height !== ch) {
        probeCanvas.width = cw;
        probeCanvas.height = ch;
      } else {
        probeCtx.clearRect(0, 0, cw, ch);
      }
      probeCtx.drawImage(img, 0, 0, cw, ch);
      const data = probeCtx.getImageData(0, 0, cw, ch).data;
      let nonTransparentPx = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] >= 4) nonTransparentPx++;
      }
      return { validImg: nonTransparentPx > 0, nonTransparentPx };
    };

    const items = [];
    const thumbs = [...root.querySelectorAll('.pc-anim-thumb')];
    for (let idx = 0; idx < thumbs.length; idx++) {
      const thumb = thumbs[idx];
      const cardEl = thumb.closest('[data-pc-card], [data-pc-part-cell], .pc-lib-thumb');
      const id = cardEl?.getAttribute('data-pc-card')
        || cardEl?.getAttribute('data-pc-part-cell')
        || `overview-${idx}`;
      const mode = thumb.getAttribute('data-pc-thumb') || 'missing';
      const ready = thumb.getAttribute('data-pc-thumb-ready') === '1';
      const t = Number(thumb.getAttribute('data-pc-thumb-time'));
      const phase = Number(thumb.getAttribute('data-pc-thumb-phase'));
      const score = Number(thumb.getAttribute('data-pc-thumb-score'));

      let nonBlank = false;
      if (mode === 'img') {
        const img = thumb.querySelector('img');
        if (img) {
          const r = await inspectImg(img);
          nonBlank = r.validImg;
        }
      } else if (mode === 'dom') {
        const stage = thumb.querySelector('.pc-stage');
        if (stage) {
          const imgs = [...stage.querySelectorAll('img')];
          let anyImgOk = false;
          for (const im of imgs) {
            const r = await inspectImg(im);
            if (r.validImg) { anyImgOk = true; break; }
          }
          const leaves = [...stage.querySelectorAll('*')].filter((el) => {
            const tag = el.tagName.toUpperCase();
            if (['SCRIPT', 'STYLE', 'DEFS', 'CLIPPATH', 'LINEARGRADIENT', 'RADIALGRADIENT', 'STOP'].includes(tag)) {
              return false;
            }
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) <= 0.01) {
              return false;
            }
            const rc = el.getBoundingClientRect();
            return rc.width > 0.5 && rc.height > 0.5;
          });
          nonBlank = anyImgOk || leaves.length > 0;
        }
      }

      items.push({ id, mode, ready, t, phase, score, nonBlank });
    }
    return items;
  }, scopeSelector);
}

let server = null;
let tmp = null;
let browser = null;
const pageErrors = [];

try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-anim-thumbs-probe-'));
    server = await startDevServer({
      port: PORT,
      logFile: path.join(tmp, 'vite.log'),
      env: {
        PROMPTCUT_NO_PORT_FILE: '1',
        PROMPTCUT_PUSH: '0',
        PROMPTCUT_EXPORT_DIR: path.join(tmp, 'export'),
        PROMPTCUT_DATA_DIR: path.join(tmp, 'data'),
        PROMPTCUT_CHATS_DIR: path.join(tmp, 'chats'),
        PROMPTCUT_WORK_DIR: path.join(tmp, 'work'),
        PROMPTCUT_AI_CONFIG: path.join(tmp, 'ai.json'),
      },
    });
    origin = server.origin;
  }

  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1440, height: 920 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--force-device-scale-factor=1'],
  });

  const page = await browser.newPage();
  page.on('pageerror', (err) => {
    const msg = String(err?.message ?? err);
    if (!msg.includes('favicon.ico')) pageErrors.push(msg);
  });

  await page.goto(`${origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded' });
  await openAnimationsOverview(page);

  /* ── 1. Overview group boxes & overview thumbnails ──────────────────────────────── */
  const overviewGroups = await page.evaluate(() =>
    [...document.querySelectorAll('[data-pc="animations"] [data-pc-group]')]
      .map((el) => el.getAttribute('data-pc-group')),
  );
  check(
    'overview-groups-present',
    EXPECTED_GROUPS.every((g) => overviewGroups.includes(g)),
    { overviewGroups },
  );

  const overviewThumbs = await scrollAndCollectThumbs(page, '[data-pc="animations"]');
  const badOverview = overviewThumbs.filter(
    (x) => !x.ready || (x.mode !== 'dom' && x.mode !== 'img') || !x.nonBlank || !(x.score > 0),
  );
  check(
    'overview-thumbs-valid',
    overviewThumbs.length >= EXPECTED_GROUPS.length && badOverview.length === 0,
    { count: overviewThumbs.length, badOverview: badOverview.slice(0, 5) },
  );
  if (SHOTS_DIR) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'overview.png') });
  }

  /* ── 2. Every item in all 6 Animation groups (Run 1) ────────────────────────────── */
  const run1ByKey = new Map();
  let totalTilesRun1 = 0;

  for (const groupId of EXPECTED_GROUPS) {
    await openAnimationGroup(page, groupId);

    const items = await scrollAndCollectThumbs(
      page,
      `[data-pc="animations"] [data-pc-open-group="${groupId}"]`,
      90_000,
    );
    if (SHOTS_DIR && (groupId === 'magicui' || groupId === 'lottie' || groupId === 'particles')) {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollTop = 0;
      }, `[data-pc="animations"] [data-pc-open-group="${groupId}"]`);
      await sleep(180);
      await page.screenshot({ path: path.join(SHOTS_DIR, `group-${groupId}.png`) });
    }
    totalTilesRun1 += items.length;
    const invalid = items.filter(
      (x) => !x.ready || (x.mode !== 'dom' && x.mode !== 'img') || !x.nonBlank || !Number.isFinite(x.t) || !(x.score > 0),
    );
    check(
      `group-${groupId}-all-thumbs-valid`,
      items.length > 0 && invalid.length === 0,
      { count: items.length, invalid: invalid.slice(0, 5) },
    );

    for (const item of items) {
      run1ByKey.set(`${groupId}:${item.id}`, item);
    }
  }

  /* ── 3. Representative-frame sanity on entrance / pulse / Lottie items ──────────── */
  const entranceChecks = ['magicui:mu-blur-fade', 'native:checklist', 'native:focus-card'];
  for (const k of entranceChecks) {
    const rec = run1ByKey.get(k);
    check(
      `representative-entrance-${k}`,
      !!rec && rec.t > 0.1 && rec.score > 0,
      rec ?? { missing: k },
    );
  }

  const avPulse = run1ByKey.get('native:av-pulse');
  check(
    'representative-short-pulse-av-pulse',
    !!avPulse && avPulse.t >= 0 && avPulse.t < 0.3 && avPulse.score > 0,
    avPulse ?? { missing: 'native:av-pulse' },
  );

  const lottieAdrock = run1ByKey.get('lottie:lottie-adrock');
  check(
    'representative-lottie-adrock',
    !!lottieAdrock && lottieAdrock.t > 0.5 && lottieAdrock.score > 0,
    lottieAdrock ?? { missing: 'lottie:lottie-adrock' },
  );

  /* ── 4. Hover live preview compatibility & editor clock isolation ───────────────── */
  await openAnimationGroup(page, 'magicui');
  await waitFor(
    () => page.$('[data-pc="animations"] [data-pc-card="mu-number-ticker"]'),
    15_000,
    'mu-number-ticker card',
  );
  await page.evaluate(() => {
    document.querySelector('[data-pc="animations"] [data-pc-card="mu-number-ticker"]')?.scrollIntoView({ block: 'center' });
  });
  await sleep(100);
  await page.hover('[data-pc="animations"] [data-pc-card="mu-number-ticker"]');
  const previewMounted = await waitFor(
    () => page.$('[data-pc="animations"] [data-pc-card="mu-number-ticker"] [data-pc="preview"]'),
    5_000,
    'live hover preview mount',
  );
  await page.mouse.move(0, 0);
  await sleep(300);
  const afterHover = await page.evaluate(() => {
    const card = document.querySelector('[data-pc="animations"] [data-pc-card="mu-number-ticker"]');
    return {
      liveStillMounted: !!card?.querySelector('[data-pc="preview"]'),
      thumbRestored: !!card?.querySelector('.pc-anim-thumb[data-pc-thumb-ready="1"]'),
      exportMsType: typeof window.__pcExportMs,
    };
  });
  check(
    'hover-live-preview-and-clock-isolation',
    !!previewMounted && !afterHover.liveStillMounted && afterHover.thumbRestored && afterHover.exportMsType === 'undefined',
    afterHover,
  );

  /* ── 5. Reload determinism: fresh page load produces identical thumbnails ───────── */
  await page.evaluate(() => {
    window.__pcAnimationThumbs?.clearCache();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openAnimationsOverview(page);

  const mismatches = [];
  let deterministicMatches = 0;

  for (const groupId of EXPECTED_GROUPS) {
    await openAnimationGroup(page, groupId);
    const items = await scrollAndCollectThumbs(
      page,
      `[data-pc="animations"] [data-pc-open-group="${groupId}"]`,
      90_000,
    );
    for (const item of items) {
      const k = `${groupId}:${item.id}`;
      const prev = run1ByKey.get(k);
      if (
        !prev
        || prev.mode !== item.mode
        || prev.t !== item.t
        || prev.phase !== item.phase
        || prev.score !== item.score
      ) {
        mismatches.push({ key: k, run1: prev ?? null, run2: item });
      } else {
        deterministicMatches++;
      }
    }
  }

  check(
    'reload-determinism-all-groups',
    deterministicMatches === totalTilesRun1 && mismatches.length === 0,
    { totalTilesRun1, deterministicMatches, mismatches: mismatches.slice(0, 5) },
  );

  check('no-page-errors', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) });
} catch (err) {
  check('probe-execution', false, { error: String(err?.stack ?? err).slice(0, 1000) });
} finally {
  try { await browser?.close(); } catch { /* Ignore */ }
  try { server?.stop(); } catch { /* Ignore */ }
  if (tmp && !KEEP) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Ignore */ }
  }
}

const fails = results.filter((r) => !r.ok).map((r) => r.check);
const summary = {
  ok: fails.length === 0,
  passes: results.length - fails.length,
  fails,
};
console.log(JSON.stringify({ ok: summary.ok, passes: summary.passes, fails: summary.fails, summary }));
process.exit(summary.ok ? 0 : 1);
