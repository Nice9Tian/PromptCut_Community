/**
 * 编辑台冒烟(E0 / E1 / D3 页面侧):真的打开编辑台(?editor),经 store 加两张卡、seek,
 * 看 Preview 是否只经 RPC 把项目和时间送到了舞台 iframe、命中测试和选中描边是否照常工作。
 *
 *   node scripts/probes/editor-preview-smoke.mjs [--origin http://127.0.0.1:5211] [--stage | --legacy]
 *
 * 不带 `--origin` 就看 `PC_STAGE_TEST_URL`,再没有就打 `.claude/launch.json` 的 `dev-test`。
 *
 * `--stage` 打开 `?preview=stage`(两个跨源舞台 iframe,E1),`--legacy` 打开
 * `?preview=legacy`(一个同源舞台 iframe)。**两个都不带就是「缺省是什么就验什么」**。
 *
 * R7 之前缺省是 legacy,所以不带参数 = legacy;**R7 把缺省翻成了 stage**,
 * 不带参数就成了 stage。回滚那一条因此要显式写 `--legacy` —— 不然翻开关之后
 * 「验 legacy」的那一趟其实打开的是新路,断言必然对不上。
 *
 * **同一台 dev server 上可以连跑**,每一趟都从同一个起点开始:
 *   - 先 `newProject` 换成空项目,再加两张卡,并断言项目里只有这两张;
 *   - 两张卡的文字参数带上本趟的标记。dev server 把每张卡的成本记录存在盘上
 *     (`out/card-costs.json`,跨趟、跨重启都在),按卡片身份(卡 + 参数 + 长度 + …)取用,
 *     K6 打上的 `demoted` 还会粘住。参数不变的话,下一趟一开场就按上一趟的降级记录走,
 *     实测那一趟 seek 之后舞台上两张卡的本地帧读到 0,「本地帧 45」那条挂。换了参数就是一张没见过的卡。
 *     代价是每趟往那台 server 的记录里多添几条;
 *   - 编辑台带 `nosetup=1`:首启 AI 设置对话框要等 `/api/ai/providers` 回来才弹,早晚不定,
 *     弹出来正好盖在点击点上,点不中预览。
 *
 * **舞台里的 DOM 一律走 puppeteer 的 frame 句柄**(`page.frames()` 对跨源 iframe 照样给得出),
 * 不用 `iframe.contentDocument` —— 跨源模式下父页碰不到它。
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin } from './probe-connect.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const forceStage = args.includes('--stage');
const forceLegacy = args.includes('--legacy');
/** 缺省不带参数:开 `/?editor`,页面自己按 `previewMode()` 的缺省决定走哪条路 */
const editorQuery = '/?editor&nosetup=1' + (forceStage ? '&preview=stage' : forceLegacy ? '&preview=legacy' : '');
/** 本趟的标记,写进两张卡的文字参数:同一台 server 上前几趟留下的成本记录对不上这两张卡(见文件头) */
const runTag = Date.now().toString(36);
const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
/** 显式指定时就是它;不带参数时等页面加载完按「有没有第二个舞台」认出来 */
let stageMode = forceStage;
const out = { mode: forceStage ? 'stage' : forceLegacy ? 'legacy' : '(默认,待认)', modeFrom: forceStage || forceLegacy ? 'flag' : 'default' };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin + editorQuery, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 120000 });
  // 舞台握手 → stageBridge 里登记了 front 客户端
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage();
  }, { timeout: 120000, polling: 500 });
  /** 可见舞台那个 iframe 的 frame 句柄(跨源时父页摸不到它的 document) */
  /**
   * 可见舞台那个 iframe。**不能写死 id=A**:K5 的角色互换(R5)之后可见舞台可能是 B,
   * 而那时 A 手里多半是探针的缩水项目 —— 照 A 去读 `data-pc-local-frame` 量到的是另一台戏。
   * 谁是 front 由父页的 `__pcPreviewDiag()` 说了算;legacy / 还没就绪时退回 A。
   */
  /*
   * 不带参数时:缺省是什么就验什么。判据是「页面真的挂了两个舞台 iframe」——
   * `?preview=stage` 但端口被占的那一档只有一个 iframe,行为和 legacy 一样,
   * 该按 legacy 验。给 back 一点时间登记再认。
   */
  if (!forceStage && !forceLegacy) {
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-pc^="stage-frame"]').length === 2,
      { timeout: 8000, polling: 200 }).catch(() => {});
    stageMode = await page.evaluate(() => document.querySelectorAll('iframe[data-pc^="stage-frame"]').length === 2);
    out.mode = stageMode ? 'stage' : 'legacy';
  }
  const frontId = async () => (await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag().frontId : 'A'))) || 'A';
  const stageFrame = (id = 'A') => page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${id}`));
  out.roles = await page.evaluate(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return { backRole: m.backRole(), hasBack: m.backStage() !== m.frontStage() };
  });
  if (stageMode) {
    // E1:第二个 iframe 在、而且真的登记成了 back
    await page.waitForFunction(async () => {
      const m = await import('/src/editor/stageBridge.ts');
      return m.backRole() === 'back';
    }, { timeout: 120000, polling: 500 });
    out.roles = await page.evaluate(async () => {
      const m = await import('/src/editor/stageBridge.ts');
      return { backRole: m.backRole(), hasBack: m.backStage() !== m.frontStage() };
    });
    const origins = await page.evaluate(() => ({
      frames: [...document.querySelectorAll('iframe[data-pc^="stage-frame"]')].map((f) => new URL(f.src).origin),
      page: location.origin,
    }));
    out.stageOrigins = origins;
    check(origins.frames.length === 2 && origins.frames[0] !== origins.frames[1] && origins.frames.every((o) => o !== origins.page),
      'two stage iframes, each on its own origin and neither is the editor origin', origins);
    check(out.roles.backRole === 'back' && out.roles.hasBack, 'the second iframe is registered as the back stage', out.roles);
  } else {
    check(out.roles.backRole === 'front' && !out.roles.hasBack, 'legacy keeps a single same-origin stage (back falls back to front)', out.roles);
  }

  await page.evaluate(() => { window.__smokeMarker = 1; });
  const ids = await page.evaluate(async (runTag) => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.newProject('smoke'); // 编辑台开场会往空项目里塞演示卡,先换成空项目
    const a = actions.addCardClip('odometer', 0, { duration: 10, params: { label: `冒烟 ${runTag}` } });
    const b = actions.addCardClip('punch-pill', 0, { duration: 10, params: { text: `冒烟 ${runTag}` } });
    actions.seek(1.5);
    return { odo: a?.id, pill: b?.id, tracks: getState().project.tracks.map((t) => t.clips.length) };
  }, runTag);
  out.runTag = runTag;
  out.ids = ids;
  check(ids.odo && ids.pill, 'clips added', ids);
  check(ids.tracks.reduce((n, k) => n + k, 0) === 2, 'the run starts from an empty project (only its own two clips)', ids.tracks);
  await sleep(1500);

  const wraps = await stageFrame(await frontId()).evaluate(() =>
    [...document.querySelectorAll('[data-pc-clip]')].map((el) => ({ id: el.getAttribute('data-pc-clip'), frame: el.getAttribute('data-pc-local-frame') })));
  const stageState = await page.evaluate(async (wraps) => {
    const { frontStage, pushedProject } = await import('/src/editor/stageBridge.ts');
    const { getState } = await import('/src/store/project.ts');
    const synced = pushedProject('front') === getState().project;
    const size = await frontStage().size();
    return { wraps, synced, size, t: getState().t };
  }, wraps);
  out.stage = stageState;
  check(stageState.wraps.length === 2 && stageState.wraps.every((w) => w.frame === '45'), 'stage shows both clips at local frame 45 (t=1.5s @30fps)', stageState);
  check(stageState.synced, 'stageBridge baseline equals the store project after sync', stageState.synced);

  // 描边:选中 odometer 后描边应贴着内容(比整幅小)
  const sel = await page.evaluate(async (odo) => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.select([odo]);
    await new Promise((r) => setTimeout(r, 400));
    // 再拨一次时间让 refreshRects 走一遍
    actions.seek(1.6);
    await new Promise((r) => setTimeout(r, 600));
    const hit = document.querySelector('.pc-pv-hit');
    const frame = document.querySelector('.pc-pv-frame');
    const r = hit?.getBoundingClientRect(); const fr = frame?.getBoundingClientRect();
    return { selection: getState().selection, hit: r ? { w: r.width, h: r.height } : null, frame: fr ? { w: fr.width, h: fr.height } : null };
  }, ids.odo);
  out.sel = sel;
  check(sel.hit && sel.frame && sel.hit.w < sel.frame.w * 0.9 && sel.hit.h < sel.frame.h * 0.9, 'selection outline hugs the odometer content (smaller than the frame)', sel);

  // 点击:在 odometer 内容中心点一下,选中的应是它(命中经 RPC 往返)
  const click = await page.evaluate(async (odo) => {
    const { frontStage } = await import('/src/editor/stageBridge.ts');
    const { actions } = await import('/src/store/project.ts');
    actions.select([]);
    const list = await frontStage().rectsWithBounds({ pixels: 'all' });
    const b = list.find((x) => x.clipId === odo)?.bounds;
    // 内容框的正中可能落在两位数字之间的空隙上(透明处穿透),在框内扫一个小网格找一个真能命中它的点
    let px = null;
    for (let iy = 1; iy < 6 && !px; iy++) for (let ix = 1; ix < 12 && !px; ix++) {
      const x = b.left + (b.width * ix) / 12, y = b.top + (b.height * iy) / 6;
      const h = await frontStage().hitTest(x, y);
      if (h && h.clipId === odo) px = { x, y };
    }
    const frame = document.querySelector('.pc-pv-frame').getBoundingClientRect();
    const scale = frame.width / 1920;
    if (!px) return null;
    const pt = { x: frame.left + px.x * scale, y: frame.top + px.y * scale };
    // 选中之后编辑台会在预览上方弹出建议卡(.ais-card)之类的浮层,点在它上面就不是点预览;先按 Escape 收掉,再确认最上层是预览覆盖层
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const top = document.elementFromPoint(pt.x, pt.y);
    return { ...pt, top: top ? top.tagName + '.' + top.className : null, inPreview: !!top?.closest('.pc-pv-frame') };
  }, ids.odo);
  check(!!click, 'found a solid point inside the odometer content box');
  check(click && click.inPreview, 'the click point is on the preview overlay (no floating panel over it)', click);
  if (click) await page.mouse.click(click.x, click.y);
  await sleep(1200);
  const after = await page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    return getState().selection;
  });
  out.clickSelection = after;
  check(after.length === 1 && after[0] === ids.odo, 'clicking the odometer content selects it via async hitTest', after);

  // 点空白:取消选中
  const blank = await page.evaluate(() => { const fr = document.querySelector('.pc-pv-frame').getBoundingClientRect(); return { x: fr.left + 20, y: fr.top + 20 }; });
  await page.mouse.click(blank.x, blank.y);
  await sleep(400);
  out.blankSelection = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().selection);
  check(out.blankSelection.length === 0, 'clicking blank deselects', out.blankSelection);

  // 播放 1 秒。stage 模式下 pause() 只同步改 store.playing，舞台要经异步 RPC 才停。
  // 只观察播放器自行停拍；不能由探针再发 pause()，否则会掩盖播放器漏发 RPC 的故障。
  const atPause = await page.evaluate(async () => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.seek(0.5); actions.play();
    await new Promise((r) => setTimeout(r, 1000));
    actions.pause();
    return getState().t;
  });
  const readHead = () => page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    const preview = typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null;
    return { t: getState().t, playing: getState().playing, frontId: preview?.frontId || 'A' };
  });
  let play;
  if (stageMode) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const before = await readHead();
      const stage = await stageFrame(before.frontId).evaluate(() => ({
        diag: typeof window.__pcStageDiag === 'function' ? window.__pcStageDiag() : null,
        frames: [...document.querySelectorAll('[data-pc-clip]')].map((el) => Number(el.getAttribute('data-pc-local-frame'))),
      }));
      const after = await readHead();
      // 前后两次父页读数夹住舞台读数；停拍后时刻不再变，得到一致的跨进程样本。
      if (!before.playing && !after.playing && before.frontId === after.frontId && before.t === after.t
        && stage.diag?.role === 'front' && !stage.diag.beatRunning && stage.diag.beatPaused
        && Math.abs(stage.diag.beatLastSec - before.t) < 1e-6) {
        play = { t: before.t, atPause, stoppedAt: stage.diag.beatLastSec, frames: stage.frames };
        break;
      }
      await sleep(20);
    }
    if (!play) throw new Error('player did not settle to the same store and stage frame within 10s');
  } else {
    const frames = await stageFrame(await frontId()).evaluate(() =>
      [...document.querySelectorAll('[data-pc-clip]')].map((el) => Number(el.getAttribute('data-pc-local-frame'))));
    play = { t: atPause, stoppedAt: null, frames };
  }
  // 播放没跟上时要看得见是谁停的(K4 的节拍在舞台里,父页只收 frame)
  play.preview = await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null));
  play.stages = {};
  for (const f of page.frames()) {
    if (!f.url().includes('stage=1')) continue;
    const id = f.url().includes('id=A') ? 'A' : 'B';
    play.stages[id] = await f.evaluate(() => (typeof window.__pcStageDiag === 'function' ? window.__pcStageDiag() : null)).catch(() => null);
  }
  out.play = play;
  check(play.t > 1.0 && play.frames.every((n) => Math.abs(n - Math.round(play.t * 30)) <= 1),
    'after 1s of playback the stage local frame follows store.t', play);

  // get_layout 的页面侧(D4):经后台舞台的单飞队列量实体框。legacy 下队列退回可见舞台,
  // 跨源双舞台下它先 setRole('back', { job: 'catchup' })、量完交还 —— 两边回的数该一样
  const layout = await page.evaluate(async (odo) => {
    const { contentLayoutOf } = await import('/src/mcp/common.ts');
    const r = await contentLayoutOf([odo]);
    return r[odo];
  }, ids.odo);
  out.layout = layout;
  check(layout && layout.contentBox && layout.contentBox.width > 0 && layout.contentBox.width < 1920 * 0.9,
    'get_layout (contentLayoutOf) measures a content box through the back-stage job queue', layout);

  // 移动工具拖一下:命中 → 拖 → 松手写 frame。这条走的是 hitTest 的异步往返 + nudgeFrame
  const dragStart = await page.evaluate(async (odo) => {
    const { actions } = await import('/src/store/project.ts');
    actions.select([odo]);
    // 工具行第二个钮是「移动」
    document.querySelectorAll('.pc-pv-tool')[1].click();
    await new Promise((r) => setTimeout(r, 200));
    const hit = document.querySelector('.pc-pv-hit').getBoundingClientRect();
    return { x: hit.left + hit.width / 2, y: hit.top + hit.height / 2 };
  }, ids.odo);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 40, dragStart.y + 24, { steps: 8 });
  await page.mouse.up();
  await sleep(600);
  out.drag = await page.evaluate(async (odo) => {
    const { getState } = await import('/src/store/project.ts');
    const { findClip } = await import('/src/kernel/project.ts');
    return findClip(getState().project, odo)?.clip.frame ?? null;
  }, ids.odo);
  check(out.drag && Number.isFinite(out.drag.x) && Number.isFinite(out.drag.y), 'dragging with the move tool writes a clip frame', out.drag);
  await page.evaluate(() => { document.querySelectorAll('.pc-pv-tool')[0].click(); });

  // 其它 agent 改文件会让 vite 整页重载,那样的一轮结果不可信:标记丢了就报出来
  out.reloaded = await page.evaluate(() => window.__smokeMarker !== 1);
  check(!out.reloaded, 'page was not reloaded by HMR during the run (rerun when the tree is quiet)');
  out.errors = errors.filter((e) => !/favicon|Download the React DevTools|Failed to load resource/i.test(e));
  check(out.errors.length === 0, 'no page errors', out.errors.slice(0, 5));
} catch (err) {
  fails.push('exception: ' + (err && err.stack || err));
} finally {
  await browser.close();
}
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(fails.length ? 1 : 0);
