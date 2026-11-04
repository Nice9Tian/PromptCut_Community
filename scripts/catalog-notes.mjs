/**
 * Two-step tool to generate "descriptions written by vision models" for the asset catalog
 * (server/catalog/{lottie,particles}).
 *
 * Workflow has three steps in total; the middle step relies on an external model and is not in this script:
 *   1. node scripts/catalog-notes.mjs sheets --url http://127.0.0.1:<self-started dev server port>/?export=1 [--out <dir>] [--only lottie:gatin,particles:snow]
 *      Prerenders a segment for each asset on the export pipeline (Lottie 3s, particles 2s),
 *      samples 6 frames chronologically, stitches them horizontally into a strip image with index
 *      numbers and timestamps (dark background so white particles are visible), written to
 *      <out>/<kind>__<name>.png.
 *   2. Hand <out> to a vision model (dispatch manager running gemini-3.8-flash via subagent-agy skill),
 *      have it write note (what happens in the 6 frames, ≤40 words), use (suitable occasions), and
 *      3 tags for each image, summarized into <out>/notes.json: { "<kind>__<name>": { note, use, tags } }.
 *   3. node scripts/catalog-notes.mjs merge --notes <out>/notes.json
 *      Merges note / use / tags into both index.json files; human-written description is kept as
 *      fallback. The catalog at the end of card_authoring_guide prioritizes note (see renderAssets
 *      in server/vite-plugin-cards.ts).
 *
 * Why a 6-frame strip instead of full video: model image inspection is far cheaper than video, and
 * 6 frames with timestamps are enough to explain "what it is and how it moves"; during the first
 * run of 58 assets, manager sampled 3 for manual comparison: 2 were correct and 1 had motion
 * direction reversed (reworked), showing this granularity is sufficient but requires spot checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { openBakery, bakeFrames } from '../server/bakery/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'server', 'catalog');
const KINDS = {
  lottie: { seconds: 3, clip: (it) => ({ cardId: 'lottie', params: { json: '', src: it.url, loop: 'yes' } }) },
  particles: { seconds: 2, clip: (it) => ({ cardId: 'particles', params: { config: it.url, seed: 1 } }) },
};

function readIndex(kind) {
  return JSON.parse(fs.readFileSync(path.join(CATALOG, kind, 'index.json'), 'utf8'));
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else o._.push(argv[i]);
  }
  return o;
}

async function sheets(o) {
  // Address must be provided explicitly (--url or env var PROMPTCUT_BASE); does not default to
  // connecting to the user's resident editor (5190-5192)
  const base = process.env.PROMPTCUT_BASE ? `${process.env.PROMPTCUT_BASE.replace(/\/+$/, '')}/?export=1` : '';
  const url = typeof o.url === 'string' ? o.url : base;
  if (!url) {
    console.error('Usage: node scripts/catalog-notes.mjs sheets --url <export page URL> (or set the environment variable PROMPTCUT_BASE)\nNo URL, no run: it does not default to connecting to the user\'s resident editor.');
    process.exit(2);
  }
  const out = path.resolve(o.out || path.join(ROOT, 'out', 'catalog-sheets'));
  const only = o.only ? new Set(String(o.only).split(',')) : null;
  fs.mkdirSync(out, { recursive: true });
  const framesRoot = path.join(out, '.frames');

  const items = [];
  for (const [kind, spec] of Object.entries(KINDS)) {
    for (const it of readIndex(kind).items) {
      if (only && !only.has(`${kind}:${it.name}`)) continue;
      items.push({ kind, name: it.name, seconds: spec.seconds, clip: spec.clip(it) });
    }
  }
  console.log(`${items.length} assets, rendering a clip for each and then sampling 6 frames…`);

  const bakery = await openBakery({ url });
  const sheetBrowser = await puppeteer.launch({ headless: true, args: ['--disable-gpu'] });
  const page = await sheetBrowser.newPage();
  await page.setViewport({ width: 2940, height: 360, deviceScaleFactor: 1 });
  try {
    for (const it of items) {
      const dir = path.join(framesRoot, `${it.kind}__${it.name}`);
      fs.rmSync(dir, { recursive: true, force: true });
      await bakery.reset({
        version: 1, name: 'sheet', width: 1920, height: 1080, fps: 30, duration: it.seconds, themeId: 'midnight', media: [],
        tracks: [{ id: 't1', name: 's1', clips: [{ id: 'c1', start: 0, end: it.seconds, ...it.clip }] }],
      });
      const r = await bakeFrames(bakery, { out: dir, format: 'png' });
      const frames = fs.readdirSync(r.framesDir).filter((f) => f.endsWith('.png')).sort();
      const N = frames.length;
      const picks = [0, 1, 2, 3, 4, 5].map((i) => Math.round((i * (N - 1)) / 5));
      const cells = picks.map((fi, i) => {
        const b64 = fs.readFileSync(path.join(r.framesDir, frames[fi])).toString('base64');
        const t = ((fi / (N - 1)) * it.seconds).toFixed(2);
        return `<div class=c><img src="data:image/png;base64,${b64}"><div class=l>${i + 1}  ·  t=${t}s (frame ${fi})</div></div>`;
      }).join('');
      await page.setContent(
        `<html><body style="margin:0;background:#141414;font-family:system-ui"><div style="display:flex;gap:10px;padding:10px">${cells}</div>` +
        `<style>.c{width:470px}.c img{width:470px;height:264px;display:block;background:#1e1e1e;border:1px solid #333}.l{color:#ddd;font:600 22px system-ui;padding:6px 0 0}</style></body></html>`,
        { waitUntil: 'load' },
      );
      const file = path.join(out, `${it.kind}__${it.name}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 2900, height: 320 } });
      fs.rmSync(dir, { recursive: true, force: true });   // Frames are only for stitching, deleted once stitched
      console.log(`  ✓ ${it.kind}__${it.name}`);
    }
  } finally {
    await sheetBrowser.close();
    await bakery.close();
    fs.rmSync(framesRoot, { recursive: true, force: true });
  }
  console.log(`Contact sheets done → ${out}\nNext: give this directory to a model that can view images to write notes.json, then run merge.`);
}

function merge(o) {
  if (!o.notes) throw new Error('--notes <notes.json> is required');
  const notes = JSON.parse(fs.readFileSync(path.resolve(String(o.notes)), 'utf8'));
  let hit = 0;
  const miss = [];
  for (const kind of Object.keys(KINDS)) {
    const p = path.join(CATALOG, kind, 'index.json');
    const j = readIndex(kind);
    for (const it of j.items) {
      const n = notes[`${kind}__${it.name}`];
      if (n && n.note) {
        it.note = String(n.note);
        it.use = String(n.use || '');
        it.tags = Array.isArray(n.tags) ? n.tags.map(String) : [];
        hit++;
      } else miss.push(`${kind}__${it.name}`);
    }
    j.notes_by = 'Observations written by a model from the 6-frame contact sheet (note/use/tags), see scripts/catalog-notes.mjs; description is the human-written fallback';
    fs.writeFileSync(p, JSON.stringify(j, null, 1));
  }
  console.log(`merged ${hit}${miss.length ? `; ${miss.length} without a note: ${miss.join(' ')}` : ''}`);
}

const o = parseArgs(process.argv.slice(2));
const cmd = o._[0];
if (cmd === 'sheets') await sheets(o);
else if (cmd === 'merge') merge(o);
else {
  console.log('Usage:\n  node scripts/catalog-notes.mjs sheets --url <export page URL> [--out <dir>] [--only lottie:gatin,particles:snow]\n  node scripts/catalog-notes.mjs merge --notes <notes.json>');
  process.exit(1);
}
