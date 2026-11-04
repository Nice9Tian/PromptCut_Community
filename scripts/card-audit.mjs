/**
 * Card audit script
 * 
 * Why these checks are performed:
 * - Position independence: commit 4edf40e verified that 34/34 card visuals are independent of
 *   absolute position, so cache keys exclude position; if violated, shifting the timeline changes
 *   the visuals.
 * - Determinism: export requires two passes to be byte-for-byte identical; failure causes export
 *   flickering or inconsistent results across runs.
 * - Structural stability: HTML sample cache is stored as "one tree + per-frame value table", which
 *   breaks if structure changes; adding/removing DOM nodes with v-if/ternary expressions will
 *   invalidate the sample cache.
 * - Network requests during mounting: dynamic imports during mounting must be awaited before
 *   emitting frames; otherwise screenshots are captured before visuals are ready.
 * - Visual carrier: canvas/WebGL cannot enter DOM sampling; we need to know which cards use
 *   technologies that cannot be serialized into pure DOM.
 *
 * Usage:
 *   node scripts/card-audit.mjs --url "http://127.0.0.1:5197/?export=1"
 */

import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { openBakery, bakeFrames } from '../server/bakery/index.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = opt('--url') || 'http://127.0.0.1:5197/?export=1';

const MOCK = () => { 
  class M extends EventTarget { 
    constructor() { super(); this.readyState = 1; setTimeout(() => this.dispatchEvent(new Event('open')), 10); } 
    send() {} 
    close() {} 
  } 
  window.WebSocket = M; 
  window.location.reload = () => {}; 
};

async function run() {
  const bakery = await openBakery({ url: base });
  const plainBrowser = await puppeteer.launch({ 
    headless: 'shell', 
    args: ['--hide-scrollbars', '--disable-gpu', '--font-render-hinting=none', '--force-device-scale-factor=1', '--enable-unsafe-swiftshader'] 
  });
  
  let cardIds = [];
  try {
    const p = await plainBrowser.newPage();
    await p.evaluateOnNewDocument(MOCK);
    await p.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await p.goto(base, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__pcReady === true, { timeout: 60000 });
    cardIds = await p.evaluate(async () => {
      const reg = await import('/src/kernel/registry.ts');
      return reg.allCards().map(c => c.id);
    });
    await p.close();
  } catch (e) {
    console.error('Failed to fetch card list:', e);
    await plainBrowser.close();
    await bakery.close();
    process.exitCode = 1;
    return;
  }

  const results = [];
  let exitCode = 0;
  
  // Intra-clip frame number k
  const K_FRAMES = [3, 15, 45, 80].filter(k => k < 90);
  const A_FRAMES = K_FRAMES.map(k => Math.round(0.5 * 30) + k);
  const B_FRAMES = K_FRAMES.map(k => Math.round(7.3 * 30) + k);

  try {
    for (const id of cardIds) {
      console.log(`\n=== Auditing card: ${id} ===`);
      const res = { 
        id, 
        posPass: false, posMaxDiff: 0, posMatch: 0, posTotal: K_FRAMES.length, 
        detPass: false, detMaxDiff: 0, detMatch: 0, detTotal: K_FRAMES.length,
        structCount: 0, mountReqCount: 0, mountReqs: [],
        carriers: { canvas: 0, svg: 0, video: 0, img: 0 }, 
        error: null 
      };
      
      let page = null;
      try {
        // 1. Prerender A (start=0.5)
        const tlA = { width: 1920, height: 1080, fps: 30, duration: 4.5, clips: [{ id: 'c1', cardId: id, start: 0.5, end: 3.5, params: {} }] };
        const urlA = base + '&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(tlA)));
        await bakery.reset(null, urlA);
        const outA = path.resolve('out', 'card-audit', id, 'a');
        await bakeFrames(bakery, { out: outA, format: 'png', targetFrames: A_FRAMES, warm: 3 });

        // 2. Prerender B (start=7.3)
        const tlB = { width: 1920, height: 1080, fps: 30, duration: 11.5, clips: [{ id: 'c1', cardId: id, start: 7.3, end: 10.3, params: {} }] };
        const urlB = base + '&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(tlB)));
        await bakery.reset(null, urlB);
        const outB = path.resolve('out', 'card-audit', id, 'b');
        await bakeFrames(bakery, { out: outB, format: 'png', targetFrames: B_FRAMES, warm: 3 });

        // 3. Prerender A2 (prerender start=0.5 again)
        await bakery.reset(null, urlA);
        const outA2 = path.resolve('out', 'card-audit', id, 'a2');
        await bakeFrames(bakery, { out: outA2, format: 'png', targetFrames: A_FRAMES, warm: 3 });

        // Compare PNGs
        let posMatch = 0, posMaxDiff = 0;
        let detMatch = 0, detMaxDiff = 0;

        for (let i = 0; i < K_FRAMES.length; i++) {
          const aNum = String(A_FRAMES[i]).padStart(6, '0');
          const bNum = String(B_FRAMES[i]).padStart(6, '0');
          
          const fileA = path.join(outA, 'frames', `${aNum}.png`);
          const fileB = path.join(outB, 'frames', `${bNum}.png`);
          const fileA2 = path.join(outA2, 'frames', `${aNum}.png`);

          const imgA = PNG.sync.read(fs.readFileSync(fileA));
          const imgB = PNG.sync.read(fs.readFileSync(fileB));
          const imgA2 = PNG.sync.read(fs.readFileSync(fileA2));

          // Compare position independence
          let pDiff = 0;
          if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
            pDiff = 255;
          } else {
            for (let j = 0; j < imgA.data.length; j++) {
              const d = Math.abs(imgA.data[j] - imgB.data[j]);
              if (d > pDiff) pDiff = d;
            }
          }
          if (pDiff === 0) posMatch++;
          if (pDiff > posMaxDiff) posMaxDiff = pDiff;

          // Compare determinism
          let dDiff = 0;
          if (imgA.width !== imgA2.width || imgA.height !== imgA2.height) {
            dDiff = 255;
          } else {
            for (let j = 0; j < imgA.data.length; j++) {
              const d = Math.abs(imgA.data[j] - imgA2.data[j]);
              if (d > dDiff) dDiff = d;
            }
          }
          if (dDiff === 0) detMatch++;
          if (dDiff > detMaxDiff) detMaxDiff = dDiff;
        }
        
        res.posMatch = posMatch;
        res.posMaxDiff = posMaxDiff;
        res.posPass = posMatch === K_FRAMES.length;
        
        res.detMatch = detMatch;
        res.detMaxDiff = detMaxDiff;
        res.detPass = detMatch === K_FRAMES.length;

        if (!res.posPass || !res.detPass) exitCode = 1;

        // 4 & 5. Use an isolated regular page to perform the other checks
        page = await plainBrowser.newPage();
        await page.evaluateOnNewDocument(MOCK);
        await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

        const loadReqs = new Set();
        const mountReqs = new Set();
        let phase = 'load';
        
        page.on('request', r => {
          const u = r.url();
          if (u.startsWith('data:')) return;
          if (phase === 'load') loadReqs.add(u);
          else if (phase === 'mount' && !loadReqs.has(u)) mountReqs.add(u);
        });

        await page.goto(urlA, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__pcReady === true, { timeout: 60000 });
        
        // Seek to before clip start
        await page.evaluate(() => window.__pcSetT(0.1));
        await new Promise(r => setTimeout(r, 300));

        phase = 'mount'; // Start recording mount requests
        
        // Seek to the middle of the clip
        await page.evaluate(() => window.__pcSetT(2.0));
        await new Promise(r => setTimeout(r, 1000));
        
        res.mountReqCount = mountReqs.size;
        res.mountReqs = [...mountReqs];

        // Record visual carrier
        res.carriers = await page.evaluate(() => {
          const root = document.getElementById('root')?.firstElementChild;
          if (!root) return {canvas: 0, svg: 0, video: 0, img: 0};
          return {
            canvas: root.querySelectorAll('canvas').length,
            svg: root.querySelectorAll('svg').length,
            video: root.querySelectorAll('video').length,
            img: root.querySelectorAll('img').length,
          };
        });

        // DOM structural stability check (10 intra-clip timestamps)
        const signatures = new Set();
        for (let i = 0; i < 10; i++) {
          const t = 0.5 + (i + 0.5) * (3.0 / 10);
          await page.evaluate(s => window.__pcSetT(s), t);
          await new Promise(r => setTimeout(r, 300));
          const sig = await page.evaluate(() => {
            const root = document.getElementById('root')?.firstElementChild;
            if (!root) return '';
            const walk = (node, path) => {
              let s = node.tagName + ':' + path + ';';
              for (let j = 0; j < node.children.length; j++) {
                s += walk(node.children[j], path + '.' + j);
              }
              return s;
            };
            return walk(root, '0');
          });
          signatures.add(sig);
        }
        res.structCount = signatures.size;

      } catch (e) {
        console.error(`Error while auditing card ${id}:`, e);
        res.error = e.message;
        exitCode = 1;
      } finally {
        if (page) await page.close().catch(() => {});
      }
      results.push(res);
    }

    fs.mkdirSync('out', { recursive: true });
    fs.writeFileSync('out/card-audit.json', JSON.stringify(results, null, 2));

    console.log('\n========================================================================================');
    console.log('card id'.padEnd(20) + ' | position-independent x/y | deterministic x/y | structure variants | mount requests | canvas/svg/video/img');
    console.log('---------------------|--------------|------------|----------|------------|-----------------------');
    
    const failures = [];
    const withReqs = [];

    for (const r of results) {
      if (r.error) {
        console.log(`${r.id.padEnd(20)} | ERROR: ${r.error.slice(0, 45)}...`);
        failures.push({ id: r.id, reason: r.error });
        continue;
      }
      const posStr = `${r.posMatch}/${r.posTotal}`.padEnd(12);
      const detStr = `${r.detMatch}/${r.detTotal}`.padEnd(10);
      const strCount = String(r.structCount).padEnd(8);
      const reqCount = String(r.mountReqCount).padEnd(10);
      const carr = `${r.carriers.canvas}/${r.carriers.svg}/${r.carriers.video}/${r.carriers.img}`;
      console.log(`${r.id.padEnd(20)} | ${posStr} | ${detStr} | ${strCount} | ${reqCount} | ${carr}`);

      let reason = [];
      if (!r.posPass) reason.push(`position independence failed (max diff ${r.posMaxDiff})`);
      if (!r.detPass) reason.push(`determinism failed (max diff ${r.detMaxDiff})`);
      if (r.structCount > 1) reason.push(`unstable structure (${r.structCount} signatures)`);
      
      if (reason.length > 0) failures.push({ id: r.id, reason: reason.join('; ') });
      
      if (r.mountReqs.length > 0) {
        withReqs.push({ id: r.id, reqs: r.mountReqs });
      }
    }

    if (withReqs.length > 0) {
      console.log('\nThese cards made network requests on mount:');
      withReqs.forEach(w => {
        console.log(`- [${w.id}]`);
        w.reqs.forEach(req => console.log(`    ${req}`));
      });
    }

    if (failures.length > 0) {
      console.log('\nFailing list:');
      failures.forEach(f => console.log(`- [${f.id}] ${f.reason}`));
    } else {
      console.log('\nAll cards passed!');
    }

    process.exitCode = exitCode;

  } finally {
    await bakery.close().catch(() => {});
    await plainBrowser.close().catch(() => {});
  }
}

run().catch(e => {
  console.error('Audit script hit an uncaught error:', e);
  process.exitCode = 1;
});
