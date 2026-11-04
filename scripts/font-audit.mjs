/**
 * Font audit: for every text node in every card on the timeline, which fonts are actually
 * used? Did any fall back to system fallbacks?
 *
 * # Why it exists
 *
 * Glyphs not covered by the font stack are assigned fallback fonts picked by the browser based
 * on "what fonts are installed on the system + which Chrome build this is".
 * In actual testing on the same machine with the same HTML, two Chrome builds picked
 * differently: monospace numbers picked NSimSun on one and Courier New on the other;
 * `✓` picked Noto Sans SC on one and Segoe UI Symbol on the other; Chinese characters in
 * monospace stacks picked NSimSun on one and Noto Sans SC on the other.
 * Once glyph widths differ, the whole line shifts, and it **throws no error**: it only surfaces
 * as dozens of mismatched frames during frame-by-frame reconciliation.
 * On another machine with different fonts installed, it gets even worse. So the rule is:
 * **every glyph must resolve to a font explicitly specified in the font stack**.
 *
 * This script turns this rule into a runnable check: if the actually used font
 * (CSS.getPlatformFontsForNode) is not on the allowlist, it reports which card, which text
 * snippet, and which font it fell back to, exiting with code 1.
 *
 * # Usage
 *
 *   node scripts/font-audit.mjs --url "http://127.0.0.1:5197/?export=1" [--timeline timeline.json] [--allow "FontA,FontB"]
 *
 * If `--timeline` is not provided, it audits the demo timeline (the one loaded by default on
 * the export page). For each clip, it samples two timestamps (after entrance and before clip
 * end); semi-transparent text in entrance animations counts too: font selection has nothing to
 * do with opacity.
 * It uses the same chrome-headless-shell as export, auditing the exact characters that will
 * appear in the final video.
 *
 * The allowlist consists of theme font stacks (src/themes/index.ts) and fonts explicitly written
 * in cards. If a new card requires a new font, add it to the allowlist and document its source
 * here, rather than loosening it to "anything".
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';

/** Default allowlist: theme font stacks + fonts explicitly written in cards, all built into Windows */
const DEFAULT_ALLOW = [
  'Consolas', 'Segoe UI', 'Segoe UI Symbol', 'Segoe UI Emoji',
  'Microsoft YaHei', 'Microsoft YaHei UI',
  'Courier New', 'SimSun', 'Georgia', 'Times New Roman',
  // KaTeX formula fonts are distributed with the package (node_modules/katex) and do not use system fallback
  'KaTeX_Main', 'KaTeX_Math', 'KaTeX_AMS', 'KaTeX_Size1', 'KaTeX_Size2', 'KaTeX_Size3', 'KaTeX_Size4',
];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = opt('--url') || 'http://127.0.0.1:5197/?export=1';
const allow = new Set([...DEFAULT_ALLOW, ...(opt('--allow') || '').split(',').map((s) => s.trim()).filter(Boolean)]);
const tlPath = opt('--timeline');
const withTimeline = (tl) => base + '&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(tl)));

const MOCK = () => { class M extends EventTarget { constructor() { super(); this.readyState = 1; setTimeout(() => this.dispatchEvent(new Event('open')), 10); } send() {} close() {} } window.WebSocket = M; window.location.reload = () => {}; };

const browser = await puppeteer.launch({ headless: 'shell', args: ['--hide-scrollbars', '--disable-gpu', '--font-render-hinting=none', '--force-device-scale-factor=1', '--enable-unsafe-swiftshader'] });
try {
  // Get timeline: use the file if provided; otherwise request the demo one from the export page
  let timeline;
  if (tlPath) timeline = JSON.parse(fs.readFileSync(tlPath, 'utf8'));
  else {
    const p = await browser.newPage();
    await p.evaluateOnNewDocument(MOCK);
    await p.goto(base, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__pcReady === true, { timeout: 60000 });
    timeline = await p.evaluate(() => window.__pcTimeline);
    await p.close();
  }
  const url = withTimeline(timeline);

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(MOCK);
  await page.setViewport({ width: timeline.width || 1920, height: timeline.height || 1080, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__pcReady === true, { timeout: 60000 });
  const cdp = await page.createCDPSession();
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');

  const clips = (timeline.clips || []).filter((c) => c.cardId);
  const violations = new Map(); // key → { card, font, text, family }
  let nodesChecked = 0;
  for (const c of clips) {
    const len = c.end - c.start;
    for (const t of [c.start + Math.min(1.2, len * 0.6), c.end - Math.min(0.1, len * 0.05)]) {
      await page.evaluate((s) => window.__pcSetT(s), t);
      await new Promise((r) => setTimeout(r, 350));
      // Number each element "with its own text", then query each one for which fonts it actually used
      const n = await page.evaluate(() => {
        document.querySelectorAll('[data-fa]').forEach((e) => e.removeAttribute('data-fa'));
        let i = 0;
        for (const el of document.querySelectorAll('#root *')) {
          const own = [...el.childNodes].filter((x) => x.nodeType === 3).map((x) => x.nodeValue).join('').trim();
          if (own) el.setAttribute('data-fa', String(i++));
        }
        return i;
      });
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      for (let i = 0; i < n; i++) {
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-fa="${i}"]` });
        if (!nodeId) continue;
        const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }).catch(() => ({ fonts: [] }));
        nodesChecked++;
        // Chrome reports the "face" name where glyphs actually originate; weight is included in the name
        // (font-light YaHei is reported as "Microsoft YaHei UI Light"). Different weights in the same
        // family do not count as fallbacks; strip weight / style suffixes before checking the allowlist
        const family = (name) => name.replace(/(?:\s+(?:Thin|ExtraLight|Light|Semilight|SemiLight|Regular|Medium|Semibold|SemiBold|Bold|ExtraBold|Black|Heavy|Italic|Oblique))+$/i, '');
        const bad = fonts.filter((f) => !allow.has(f.familyName) && !allow.has(family(f.familyName)));
        if (!bad.length) continue;
        const info = await page.evaluate((k) => {
          const el = document.querySelector(`[data-fa="${k}"]`);
          return { text: (el.textContent || '').trim().slice(0, 24), family: getComputedStyle(el).fontFamily };
        }, i);
        for (const f of bad) {
          const key = `${c.cardId}|${f.familyName}|${info.family}`;
          if (!violations.has(key)) violations.set(key, { card: c.cardId, font: f.familyName, glyphs: f.glyphCount, text: info.text, family: info.family });
        }
      }
    }
  }

  console.log(`Audited ${clips.length} clips, ${nodesChecked} text node passes.`);
  if (!violations.size) {
    console.log('Font audit passed: every glyph falls on an explicitly listed font.');
  } else {
    console.log(`\n${violations.size} fell back to the system font (fonts outside the whitelist):`);
    for (const v of violations.values()) {
      console.log(`  [${v.card}] "${v.text}" → ${v.font}×${v.glyphs}   font stack: ${v.family}`);
    }
    console.log('\nFix: explicitly add a font that covers these glyphs to the matching font stack (see the notes in src/themes/index.ts), and do not loosen the whitelist.');
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
