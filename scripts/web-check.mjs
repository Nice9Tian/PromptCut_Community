/**
 * 网页操作模块的真机自检。**要联网,会起一个真的 Chrome**,所以不进 npm test
 * (那套跑 6 秒,加进去就是分钟级)。改过 server/web/ 之后手动跑一次:
 *
 *     node scripts/web-check.mjs [url]
 *
 * 它验的是单元测试验不了的那半:随包 Chrome 能不能起、离屏窗口在不在屏幕外、
 * 截图和清单出不出得来、命中检测在真页面上准不准、窗口能不能挪出来再藏回去。
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

/** 和 vite-plugin-web.ts 里那份保持一致:显式给路径,别靠 PUPPETEER_CACHE_DIR 继承 */
async function bundledChrome() {
  const { findBundledChrome } = await import('../server/vite-plugin-web.ts').catch(() => ({}));
  if (findBundledChrome) return findBundledChrome(ROOT);
  // .ts 直接 import 不了时自己找一遍
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
  console.log(`\n── 1. 起浏览器 ──`);
  console.log(`  Chrome: ${exe || '(没找到随包那份,用 puppeteer 自己的缓存)'}`);
  // 用临时 profile,不碰 out/web-profile —— 那份是用户的登录态,自检不该占用它
  // (占用了会让正在跑的 dev server 起不来浏览器,而且自检产生的 cookie 也不该留下)
  const inst = await getBrowser({ dataDir: null, executablePath: exe });
  ok(!!inst.page, '实例起来了', await inst.browser.version());

  const { bounds } = await inst.cdp.send('Browser.getWindowForTarget');
  ok(bounds.left < 0, '窗口在屏幕外', `left=${bounds.left}`);

  console.log(`\n── 2. 打开页面 + 出图和清单 ──`);
  const opened = await session.open(inst.page, URL_ARG);
  ok(opened.ok, '导航成功', opened.url);
  ok(!!opened.__image?.base64, '截到图了', `${Math.round((opened.__image?.base64.length || 0) / 1024)} KB webp`);
  ok(opened.image.width <= 800 && opened.image.height <= 800,
    '长边不超过 800', `${opened.image.width}x${opened.image.height}`);
  const vp = inst.page.viewport();
  const ratioImg = opened.image.width / opened.image.height;
  const ratioVp = vp.width / vp.height;
  ok(Math.abs(ratioImg - ratioVp) < 0.02, '宽高比和视口一致(等比缩放)',
    `图 ${ratioImg.toFixed(3)} / 视口 ${ratioVp.toFixed(3)}`);
  ok(Array.isArray(opened.clickable) && opened.clickable.length > 0,
    '出了可点清单', `${opened.clickable.length} 项${opened.omitted ? `,省略 ${opened.omitted}` : ''}`);
  const listBytes = JSON.stringify(opened.clickable).length;
  console.log(`     清单 ${listBytes} 字符 ≈ ${Math.round(listBytes / 4)} token`);

  console.log(`\n── 3. 命中检测 ──`);
  const target = opened.clickable.find((c) => c.n && c.n.length > 2 && c.b[1] > 0);
  if (!target) { ok(false, '找不到可测的目标元素'); }
  else {
    const cx = Math.round((target.b[0] + target.b[2]) / 2);
    const cy = Math.round((target.b[1] + target.b[3]) / 2);
    const hit = await resolveAt(inst.page, cx, cy);
    ok(hit.ok && hit.pick.u === target.u, '中心点能还原回同一个 uid',
      `报(${cx},${cy}) → ${hit.ok ? hit.pick.u : hit.reason},目标 ${target.u} «${target.n}»`);

    const bad = await resolveAt(inst.page, cx, cy, { expect: '这个名字页面上绝对没有' });
    ok(!bad.ok && bad.reason === 'expect_mismatch',
      'expect 对不上时拒绝,不替模型赌', `reason=${bad.reason}`);

    const far = await resolveAt(inst.page, 5, opened.image.height - 5);
    ok(!far.ok, '边角空白处正确落空', `reason=${far.reason}`);
  }

  console.log(`\n── 4. 读正文 ──`);
  const read = await session.read(inst.page, { limit: 500 });
  ok(read.ok && read.text.length > 50, '取到正文', `共 ${read.total} 字`);
  ok(!read.__image, '读正文不返图(省 token)');

  console.log(`\n── 5. 滚动 ──`);
  const scrolled = await session.scroll(inst.page, { dy: 800 });
  ok(scrolled.ok && !!scrolled.__image, '滚动后自动带回新的图和清单');

  console.log(`\n── 6. 窗口交接 ──`);
  await showWindow(inst);
  const shown = await inst.cdp.send('Browser.getWindowForTarget');
  ok(shown.bounds.left >= 0, '能挪到屏幕上交给用户', `left=${shown.bounds.left}`);
  await hideWindow(inst);
  const hidden = await inst.cdp.send('Browser.getWindowForTarget');
  ok(hidden.bounds.left < 0, '能藏回屏幕外', `left=${hidden.bounds.left}`);
} catch (e) {
  fail++;
  console.log(`\n  ✗ 抛异常:${e.stack || e.message}`);
} finally {
  await closeBrowser();
}

console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`} — ${pass} 通过 / ${pass + fail} 项,耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
process.exit(fail === 0 ? 0 : 1);
