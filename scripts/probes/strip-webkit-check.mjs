/**
 * 在**真的 WebKit**（Playwright 装的那个）里量缩略条的滚动区，把「占位 div」和「容器 padding」
 * 两种写法并排比。只量不判，退出码恒为 0 —— 原因见下面「别拿它当守门」。
 *
 *   node scripts/probes/strip-webkit-check.mjs
 *
 * 为什么有它：2026-10-24 用户在 iPhone（iOS 18.1.1）上滑不动缩略时间轴，本机无头 Chrome（Blink）
 * 怎么测都正常，白跑了两轮。装上 Playwright 的 WebKit 之后，WebKit 与 Blink 的差异在本机就能量。
 *
 * **别拿它当守门**（2026-10-24 实测得出）：Playwright 装的是**当时最新**的 WebKit，
 * 本机这一份是 **27.2**（UA 里 `Version/27.2 Safari/605.1.15`），而用户手机是 iOS 18.1.1 ——
 * 中间差了好几代。这次的病就是这样：iOS 18.1 不把零高度的空占位算进 `scrollWidth`，
 * WebKit 27.2 **算**（本机实测两种写法都是 `scroll 494 / 可滚 80`，尾占位量出来 `207x0` 也照样计入）。
 * 所以**本机两版读数一样，不等于用户手机上也一样**：它只能证明「新 WebKit 上没这个差异」，
 * 证明不了旧 iOS。真要确认旧 iOS 的行为，只有让用户在手机上开诊断页（做法见
 * `docs/archive/agent-reports/AGENT-claude-strip-snapback.md` 的「这次学到的」第 2 条）。
 */
import { webkit } from 'playwright-core';

const W = 414; // 用户那台 iPhone 的 CSS 宽度

/** 和 `src/mobile/mobile.css` 里 `.pcm .strip-scroll` 逐字一致的那串属性 */
const COMMON = `display:flex;align-items:center;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;
  min-height:80px;touch-action:pan-x;overscroll-behavior-x:contain;user-select:none;-webkit-user-select:none;`;

/** 两种写法：左右留白用占位 div（改之前）/ 用容器自己的 padding（改之后，现在线上这版） */
const PAGE = (mode) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  .strip { ${COMMON} ${mode === 'padding' ? 'padding: 6px 50% 10px calc(50% - 46px);' : 'padding: 6px 0 10px;'} }
  .strip::-webkit-scrollbar { display: none; }
  .spl { flex: none; width: calc(50% - 46px); }
  .spr { flex: none; width: 50%; }
  .add { flex: none; width: 40px; height: 64px; margin-right: 6px; background: #333; }
  .blk { flex: none; width: 80px; height: 64px; background: #777; }
</style>
<div class="strip">${mode === 'padding' ? '' : '<div class="spl"></div>'}<div class="add"></div><div class="blk"></div>${mode === 'padding' ? '' : '<div class="spr"></div>'}</div>`;

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: W, height: 800 } });
const out = {};

for (const mode of ['spacer', 'padding']) {
  await page.setContent(PAGE(mode));
  await page.waitForTimeout(120);
  out[mode] = await page.evaluate(() => {
    const el = document.querySelector('.strip');
    const spr = document.querySelector('.spr');
    const box = spr?.getBoundingClientRect();
    el.scrollLeft = 40;
    return {
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      range: el.scrollWidth - el.clientWidth,
      setTo40ReadBack: Math.round(el.scrollLeft),
      尾占位: box ? `${box.width}x${box.height}` : '无（这一版没有占位 div）',
    };
  });
}
const version = await browser.version();
const ua = await page.evaluate(() => navigator.userAgent);
await browser.close();

console.log(JSON.stringify({ engine: 'webkit', version, ua, viewport: W, ...out }, null, 1));

const same = out.spacer.range === out.padding.range;
console.log(same
  ? `\n==> 本机这份 WebKit（${version}）两种写法读数相同（各可滚 ${out.padding.range}）。`
    + `\n    它比用户的 iOS 18.1.1 新好几代，零高度占位在它这里是计入 scrollWidth 的。`
    + `\n    **这不构成「旧 iOS 上也没问题」的证据** —— 别拿这一行当守门，见本文件开头。`
  : `\n==> 两种写法读数不同：占位 ${out.spacer.range}、padding ${out.padding.range}。`
    + `\n    本机这份 WebKit（${version}）就能看出差异，可以当这一类回归的本机守门。`);
