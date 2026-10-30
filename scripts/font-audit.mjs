/**
 * 字体审计:时间轴上每张卡的每个文本节点,实际用到了哪些字体?有没有落进系统回退?
 *
 * # 为什么要有它
 *
 * 字体栈没覆盖到的字形,由浏览器按「系统里装了哪些字体 + 这是哪个 Chrome 构建」去挑回退字体。
 * 实测同一台机器、同一份 HTML,两个 Chrome 构建就挑得不一样:等宽数字一边 NSimSun、一边 Courier New;
 * `✓` 一边 Noto Sans SC、一边 Segoe UI Symbol;等宽栈里的中文一边 NSimSun、一边 Noto Sans SC。
 * 字宽一不同整行平移,而且**不报错** —— 只会在逐帧对账时冒出几十帧对不上。
 * 换一台装了不同字体的机器,情况只会更多。所以规矩是:**每个字形都要落在字体栈里显式写出的字体上**。
 *
 * 这个脚本把这条规矩变成可以跑的检查:实际用到的字体(CSS.getPlatformFontsForNode)不在白名单里,
 * 就报出是哪张卡、哪段文字、落到了什么字体,退出码 1。
 *
 * # 用法
 *
 *   node scripts/font-audit.mjs --url "http://127.0.0.1:5197/?export=1" [--timeline 时间轴.json] [--allow "字体A,字体B"]
 *
 * 不给 --timeline 就审 demo 时间轴(导出页默认加载的那条)。每个片段取两个时刻(进场后和片尾前),
 * 进场动画里半透明的文字也算 —— 字体选择和透明度无关。
 * 用的是导出同款的 chrome-headless-shell,审的就是成片里会出现的字。
 *
 * 白名单就是主题字体栈(src/themes/index.ts)和卡片里显式写出的字体。新卡要用新字体,把它加进白名单
 * 并在这里写明来源,而不是放宽成「随便」。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';

/** 默认白名单:主题字体栈 + 卡片里显式写的字体,都是 Windows 自带的 */
const DEFAULT_ALLOW = [
  'Consolas', 'Segoe UI', 'Segoe UI Symbol', 'Segoe UI Emoji',
  'Microsoft YaHei', 'Microsoft YaHei UI',
  'Courier New', 'SimSun', 'Georgia', 'Times New Roman',
  // KaTeX 公式字体随包分发(node_modules/katex),不走系统回退
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
  // 取时间轴:给了文件就用文件,否则问导出页要 demo 那条
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
      // 给每个「自己带文字」的元素打个编号,再逐个问它实际用了哪些字体
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
        // Chrome 报的是字形实际来自的「字面」名,字重会带进名字里(font-light 的雅黑报成 "Microsoft YaHei UI Light")。
        // 同一家族的不同字重不算回退,剥掉字重 / 样式后缀再对白名单
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

  console.log(`审了 ${clips.length} 个片段、${nodesChecked} 个文本节点次。`);
  if (!violations.size) {
    console.log('字体审计通过:所有字形都落在显式写出的字体上。');
  } else {
    console.log(`\n${violations.size} 处落进了系统回退(白名单以外的字体):`);
    for (const v of violations.values()) {
      console.log(`  [${v.card}] "${v.text}" → ${v.font}×${v.glyphs}   字体栈: ${v.family}`);
    }
    console.log('\n修法:在对应字体栈里显式加上能覆盖这些字形的字体(见 src/themes/index.ts 的说明),不要放宽白名单。');
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
