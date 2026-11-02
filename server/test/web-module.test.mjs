/**
 * server/web/ 的单元测试。
 *
 * 这里**不起真浏览器** —— 起一个有头 Chrome 要几百毫秒、还要联网才有页面可测,
 * 放进 npm test 会让整套测试从 6 秒变成分钟级。真浏览器的验证走 scripts/web-check.mjs
 * (手动跑,联网)。这里测的是不依赖浏览器的那半:坐标换算、拒绝话术、参数校验,
 * 以及 page 被换成假对象之后动作层的行为。
 *
 * 假 page 只实现被用到的那几个方法。**故意不做成通用 mock**:哪天 session.mjs 多调了
 * 一个 puppeteer 的方法,这里会直接 TypeError 炸掉,而不是悄悄返回 undefined 让测试
 * 假装通过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { scaleOf, captureView, liveViewport } from '../web/view.mjs';
import { explain } from '../web/hit.mjs';
import * as session from '../web/session.mjs';

// ── 坐标换算 ──────────────────────────────────────────────────────────
// 这一组是整个模块的地基:图上的坐标要能唯一还原回页面坐标。等比(单个 scale)
// 是前提 —— 一旦两个轴的比例不同,模型报的坐标就没法反算。

test('The long side is scaled to 800, the short side proportionally', () => {
  assert.equal(scaleOf({ width: 1280, height: 800 }), 800 / 1280);
  // 竖着的视口:长边是高,按高算
  assert.equal(scaleOf({ width: 600, height: 1200 }), 800 / 1200);
});

test('When the viewport is smaller than 800, it is given as is, without upscaling', () => {
  // 放大只会让图更大更贵,一个像素的信息都不会多
  assert.equal(scaleOf({ width: 640, height: 480 }), 1);
  assert.equal(scaleOf({ width: 800, height: 600 }), 1);
});

test('Both axes share one scale: the aspect ratio is unchanged', () => {
  const vp = { width: 1280, height: 800 };
  const s = scaleOf(vp);
  const img = { w: vp.width * s, h: vp.height * s };
  assert.ok(Math.abs(img.w / img.h - vp.width / vp.height) < 1e-9,
    'The image and the viewport must have the same aspect ratio, otherwise the coordinates reported by the model, mapped back, would be off by different amounts on the two axes');
});

// ── 截图不许动视口 ────────────────────────────────────────────────────
// 这条是回归测试。上一版为了缩放去改 deviceScaleFactor,有头窗口下那是一次真实的
// 窗口 resize —— 页面正在跳转时会挂住,实测 web_view 卡满 45 秒超时才返回。换成
// clip.scale 之后视口一动不动。视口一旦被动过,elementFromPoint 的坐标系就跟着变,
// 命中检测会集体偏,所以这件事必须锁死。

test('captureView never calls setViewport; scaling relies on clip.scale', async () => {
  const calls = [];
  const page = {
    viewport: () => ({ width: 1280, height: 800 }),
    setViewport: async (v) => { calls.push(v); },
    waitForFunction: async () => {},
    evaluate: async () => ({ items: [], total: 0, url: 'https://x.test/', title: 'x' }),
    screenshot: async (opts) => { calls.push({ screenshot: opts }); return 'ZmFrZQ=='; },
  };
  const out = await captureView(page);
  assert.equal(calls.filter((c) => !c.screenshot).length, 0,
    'setViewport should never be called: in a headed window it is a real resize and hangs during navigation');
  const shot = calls.find((c) => c.screenshot).screenshot;
  assert.equal(shot.clip.scale, 800 / 1280, 'Scaling must be handed to clip.scale');
  assert.equal(shot.clip.width, 1280);
  assert.equal(shot.clip.height, 800);
  assert.equal(out.image.width, 800);
  assert.equal(out.image.height, 500, '1280x800: the long side is scaled to 800, and the short side proportionally is 500');
});

test('captureView waits for the page readyState, but still captures if it never arrives', async () => {
  let waited = false;
  const page = {
    viewport: () => ({ width: 1280, height: 800 }),
    waitForFunction: async () => { waited = true; throw new Error('timeout'); },
    evaluate: async () => ({ items: [], total: 0, url: 'u', title: 't' }),
    screenshot: async () => 'ZmFrZQ==',
  };
  const out = await captureView(page);
  assert.ok(waited, 'It must wait for the load state first');
  assert.ok(out.__image.base64, 'Even if the wait times out, an image must still be given: half an image is more useful than a timeout message');
});

test('The shape of __image must be the one the harness recognizes', async () => {
  const page = {
    viewport: () => ({ width: 1280, height: 800 }),
    waitForFunction: async () => {},
    evaluate: async () => ({ items: [], total: 0, url: 'u', title: 't' }),
    screenshot: async () => 'ZmFrZQ==',
  };
  const out = await captureView(page);
  // agent.mjs 和 mcp-server.mjs 都按 __image.base64 / __image.mime 摘图,
  // 换个字段名就等于把 base64 当普通文本灌进历史,几十万字符撑爆上下文
  assert.equal(typeof out.__image.base64, 'string');
  assert.match(out.__image.mime, /^image\//);
});

// ── 拒绝话术 ──────────────────────────────────────────────────────────
// 命中检测拒绝的时候,回给模型的那句话就是它下一步的全部依据。测它的意思不是
// 测措辞,是测**每种拒绝都给出了可执行的下一步**。

test('Coordinates reported before any screenshot: tell it to run web_view first', () => {
  const msg = explain({ ok: false, reason: 'no_snapshot' });
  assert.match(msg, /web_view/);
});

test('Clicking on blank space: say what is there, and give two options', () => {
  const msg = explain({ ok: false, reason: 'empty', saw: 'This is a paragraph of body text' });
  assert.match(msg, /This is a paragraph of body text/);
  assert.match(msg, /u/, 'It must hint that u can be used to specify the target directly');
});

test('Multiple candidates: each one carries a directly callable u', () => {
  const msg = explain({
    ok: false, reason: 'ambiguous',
    cands: [
      { u: 'e7', n: 'CSS', t: 'button', b: [183, 79, 229, 107], d: 0 },
      { u: 'e6', n: 'HTML', t: 'button', b: [128, 79, 183, 107], d: 2 },
    ],
  });
  assert.match(msg, /u="e7"/);
  assert.match(msg, /u="e6"/);
  assert.match(msg, /web_click/, 'It must say explicitly to specify with web_click, so it does not have to guess the next step');
});

test('Candidates covered by a layer above must be flagged', () => {
  const msg = explain({
    ok: false, reason: 'ambiguous',
    cands: [{ u: 'e3', n: 'Download', t: 'a', b: [0, 0, 10, 10], d: 0, stacked: true }],
  });
  assert.match(msg, /covered/, 'Clicking directly on an element underneath a popup gets intercepted, so a warning is required');
});

test('expect does not match: echo expect back verbatim so the model knows what it was looking for', () => {
  const msg = explain({
    ok: false, reason: 'expect_mismatch', expect: 'Log in',
    cands: [{ u: 'e1', n: 'Sign up', t: 'a', b: [0, 0, 10, 10], d: 4 }],
  });
  assert.match(msg, /login|logged in/);
  assert.match(msg, /Sign up/);
});

test('No message is produced when the hit succeeds', () => {
  assert.equal(explain({ ok: true, pick: { u: 'e1' } }), null);
});

// ── 动作层的参数校验 ──────────────────────────────────────────────────

test('web_click given neither u nor coordinates: rejected on the spot, without touching the page', async () => {
  // page 传 null:一旦实现里先去动页面再校验,这里会 TypeError 而不是拿到干净的错误
  const r = await session.click(null, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /u/);
  assert.match(r.error, /x,y/);
});

test('web_click given only x and no y also counts as no coordinates', async () => {
  const r = await session.click(null, { x: 100 });
  assert.equal(r.ok, false);
});

test('When web_type cannot find the number, it says explicitly that numbers expire with the screenshot', async () => {
  const page = { $: async () => null };
  const r = await session.type(page, { u: 'e99', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /web_view/, 'It must tell the model to take a new screenshot, otherwise it will keep retrying with the same dead number');
});

test('When web_click gets a number that does not exist, it likewise explains the reason', async () => {
  const page = { $: async () => null };
  const r = await session.click(page, { u: 'e99' });
  assert.equal(r.ok, false);
  assert.match(r.error, /e99/);
  assert.match(r.error, /web_view/);
});

// ── 串行队列 ──────────────────────────────────────────────────────────

test('enqueue is strictly serial: the next one must wait for the previous one to finish', async () => {
  const order = [];
  const slow = session.enqueue(async () => {
    order.push('slow-start');
    await new Promise((r) => setTimeout(r, 30));
    order.push('slow-end');
  });
  const fast = session.enqueue(async () => { order.push('fast'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['slow-start', 'slow-end', 'fast']);
});

test('An error thrown by the previous one does not jam the queue', async () => {
  await session.enqueue(async () => { throw new Error('boom'); }).catch(() => {});
  const r = await session.enqueue(async () => 'still alive');
  assert.equal(r, 'still alive');
});

// ── 交接 ──────────────────────────────────────────────────────────────

test('web_handoff moves the window into view and explicitly requires the agent to stop', async () => {
  const calls = [];
  const inst = {
    cdp: { send: async (m, p) => { calls.push({ m, s: p?.bounds?.windowState, left: p?.bounds?.left }); } },
    page: { bringToFront: async () => calls.push({ m: 'front' }) },
    windowId: 1,
  };
  const r = await session.handoff(inst, { reason: 'Bilibili QR code login' });
  assert.equal(r.ok, true);
  assert.equal(r.visible, true);
  assert.match(r.message, /Bilibili QR code login/);
  assert.match(r.message, /not continue calling tools/, 'The agent must stop and wait for a person, and must not keep clicking on its own');

  // 实测 Windows 上直接挪回屏幕内窗口仍是隐藏的:必须先 minimized 再 normal(见 showWindow 注释)
  assert.equal(calls[0].s, 'minimized', 'The first step must be minimized, otherwise the window cannot be seen even if its position is right');
  assert.ok(calls.some((c) => c.s === 'normal'), 'It must be restored to normal');
  const placed = calls.find((c) => typeof c.left === 'number');
  assert.ok(placed && placed.left >= 0, 'The position must be placed on screen at least once');
  assert.ok(calls.some((c) => c.m === 'Emulation.clearDeviceMetricsOverride'),
    'When handing over to a person, viewport emulation must be removed, otherwise the displayed content does not grow when the window is enlarged');
  noStateWithPosition(calls);
});

/**
 * **状态和位置绝不能塞进同一次 setWindowBounds。**
 *
 * 这不是风格问题,是 CDP 的实际行为:两者同时给时它只认状态、把位置整个丢掉。
 * 实测(Windows 11,逐步打过 bounds):
 *   minimized 之后            {"left":-32000,...,"windowState":"minimized"}
 *   normal + left:120 一次发   {"left":-32000,...,"windowState":"normal"}   ← 位置没生效
 *   还原之后再单独发 bounds    {"left":120,"top":80,...}                     ← 这才对
 *
 * 犯了这个错的后果是**静默**的:showWindow 里窗口留在屏幕外,agent 却以为已经交给用户了;
 * hideWindow 里(用户最大化过之后)窗口留在屏幕上,agent 却以为已经藏好了。
 * 两边都不报错,所以只能靠这条测试守着。
 */
function noStateWithPosition(calls) {
  for (const c of calls) {
    if (c.m !== 'Browser.setWindowBounds') continue;
    assert.ok(!(c.s && typeof c.left === 'number'),
      `setWindowBounds was given both windowState=${c.s} and left=${c.left}: the position will be dropped by CDP`);
  }
}

test('web_handoff hide:true hides the window back off-screen', async () => {
  const calls = [];
  const inst = {
    cdp: { send: async (m, p) => { calls.push({ m, s: p?.bounds?.windowState, left: p?.bounds?.left }); } },
    page: { bringToFront: async () => {}, setViewport: async () => {} },
    windowId: 1,
  };
  const r = await session.handoff(inst, { hide: true });
  assert.equal(r.visible, false);
  const placed = calls.find((c) => typeof c.left === 'number');
  assert.ok(placed && placed.left < 0, 'Hiding it again must use negative coordinates');
  // 用户在接管期间可能把窗口最大化过,那时 hide 是一次真的状态变更 —— 同样不能和位置一起发
  noStateWithPosition(calls);
});

// ── 热重启后的浏览器接管 ──────────────────────────────────────────────
// 起因是并行的那个会话报的真 bug:dev 下 Vite 一热重启就把 browser.mjs 换掉一份新的,
// 模块级的 instance 归零,**但上一份起的 Chrome 还活着、还握着 out/web-profile**。
// 之后所有 web_* 全部报「被另一个实例占着」,直到手动去杀那个 Chrome。已复现并修掉。
// 这里锁住的是「怎么分辨孤儿和别人正在用的」这条判据 —— 判错了就是替别人把浏览器关了。

test('closeBrowser only disconnects a shared instance and does not close the browser on behalf of others', async () => {
  const acts = [];
  const fake = {
    connected: true,
    close: async () => acts.push('close'),
    disconnect: async () => acts.push('disconnect'),
  };
  // 直接构造一个 shared 实例来验分支:真起浏览器太慢,而这里要锁的就是分支本身
  const mod = await import('../web/browser.mjs?shared-test=1');
  await mod.getBrowser({
    dataDir: null,
    puppeteer: {
      launch: async () => ({
        ...fake,
        pages: async () => [{
          url: () => 'about:blank',
          setViewport: async () => {},
          createCDPSession: async () => ({ send: async () => ({ windowId: 1 }) }),
        }],
      }),
    },
  });
  await mod.closeBrowser();
  assert.deepEqual(acts, ['close'], 'One it launched itself should really be closed');
});

test('A taken-over instance carries userDataDir so that close can also clean up the stale endpoint file', async () => {
  // 实测:Chrome 干净退出后 DevToolsActivePort 并不会自己消失(Windows 上如此)。
  // 留着不出错(下次连不上会退回 launch),但每次会话开头白花一个连接往返。
  const mod = await import('../web/browser.mjs?udd-test=1');
  const inst = await mod.getBrowser({
    dataDir: null,
    puppeteer: {
      launch: async (opts) => ({
        connected: true,
        close: async () => {},
        pages: async () => [{
          url: () => 'about:blank',
          setViewport: async () => {},
          createCDPSession: async () => ({ send: async () => ({ windowId: 1 }) }),
        }],
        _opts: opts,
      }),
    },
  });
  // dataDir 为 null 时不该造 profile 目录,userDataDir 也就是 undefined
  assert.equal(inst.userDataDir, undefined, 'Passing null for dataDir means nothing is written to disk, so the login state must not remain');
  assert.equal(inst.shared, false);
  await mod.closeBrowser();
});

// ── 壳模式:agent 的浏览器是 Tauri 主窗口里的子 webview ──────────────────
// 桌面壳给 WebView2 开了 --remote-debugging-port,端口通过 PROMPTCUT_AGENT_CDP 交过来。
// getBrowser 在这个变量存在时 connect 而不是 launch,按初始地址认出 agent 那块;
// 显示 / 隐藏不再动窗口(壳里没有窗口可动),只回 shell 标记让前端 invoke 壳的命令。

function fakeShellPuppeteer(acts, pagesList) {
  return {
    launch: async () => { acts.push('launch'); throw new Error('Shell mode must not launch'); },
    connect: async (opts) => {
      acts.push(['connect', opts.browserURL]);
      return {
        connected: true,
        pages: async () => pagesList,
        disconnect: async () => acts.push('disconnect'),
        close: async () => acts.push('close'),
      };
    },
  };
}
/** agent 为 true 的页带着壳注入的 window.__PROMPTCUT_AGENT__ 标记 */
const fakePage = (url, agent = false) => ({
  url: () => url,
  evaluate: async () => agent,
  setViewport: async () => {},
  bringToFront: async () => {},
  createCDPSession: async () => ({ send: async (m) => { return m === 'Browser.getWindowForTarget' ? { windowId: 1 } : {}; } }),
});

test('Shell mode: connect to the debugging port via PROMPTCUT_AGENT_CDP, recognize the agent\'s pane by the injected marker (its address is no longer the initial one), and do not launch', async () => {
  process.env.PROMPTCUT_AGENT_CDP = '9333';
  process.env.PROMPTCUT_AGENT_URL = 'about:blank#promptcut-agent';
  try {
    const acts = [];
    const mod = await import('../web/browser.mjs?shell-test=1');
    const inst = await mod.getBrowser({
      dataDir: null,
      // agent 那块已经导航到 B 站,只有标记还在;编辑台主页面没标记
      puppeteer: fakeShellPuppeteer(acts, [fakePage('http://127.0.0.1:5210/'), fakePage('https://www.bilibili.com/', true)]),
    });
    assert.deepEqual(acts, [['connect', 'http://127.0.0.1:9333']]);
    assert.equal(inst.shell, true);
    assert.equal(inst.shared, true, 'The browser belongs to the shell, so on close it can only disconnect itself');
    assert.equal(inst.page.url(), 'https://www.bilibili.com/', 'It recognizes the marked agent pane, not the editor\'s main page');
    // 显示 / 隐藏只回标记
    assert.deepEqual(await mod.showWindow(inst), { shell: true });
    assert.deepEqual(await mod.hideWindow(inst), { shell: true });
    await mod.closeBrowser();
    assert.ok(acts.includes('disconnect') && !acts.includes('close'), 'The shell\'s browser must not be closed by Node');
  } finally {
    delete process.env.PROMPTCUT_AGENT_CDP;
    delete process.env.PROMPTCUT_AGENT_URL;
  }
});

test('Shell mode: if the port cannot be reached, fall back to the Chrome path', async () => {
  process.env.PROMPTCUT_AGENT_CDP = '9333';
  try {
    const acts = [];
    const mod = await import('../web/browser.mjs?shell-fallback-test=1');
    const inst = await mod.getBrowser({
      dataDir: null,
      puppeteer: {
        connect: async () => { acts.push('connect'); throw new Error('ECONNREFUSED'); },
        launch: async () => {
          acts.push('launch');
          return { connected: true, close: async () => {}, pages: async () => [fakePage('about:blank')] };
        },
      },
    });
    assert.deepEqual(acts, ['connect', 'launch']);
    assert.equal(inst.shell, undefined);
    await mod.closeBrowser();
  } finally {
    delete process.env.PROMPTCUT_AGENT_CDP;
  }
});

test('In shell mode handoff carries the shell flag, and the wording no longer says "window"', async () => {
  const inst = { shell: true, cdp: { send: async () => {} }, page: { setViewport: async () => {} } };
  const r = await session.handoff(inst, { reason: 'Log in' });
  assert.equal(r.shell, true);
  assert.equal(r.visible, true);
  assert.match(r.message, /in the main window/);
  const h = await session.handoff(inst, { hide: true });
  assert.equal(h.shell, true);
  assert.equal(h.visible, false);
});

// ── 壳模式:视口仿真解除时的尺寸来源 ────────────────────────────────────
// 起因是并行会话的提醒:壳模式下 web_handoff 把面板交给用户时会 setViewport(null),
// 这时 page.viewport() 返回 null。原来截图和命中检测各自回退到常量 1280x800,
// 会出两种坏法 —— 截图 clip 出界把仿真套回去(用户正在看的画面当场错位)、
// 命中检测按错的尺寸反算(**点击静默落到错误位置**,比错位更坏)。
// 现在两边都走 liveViewport,这几条锁住它。

test('With emulation active, use the emulated size directly instead of asking the page', async () => {
  let asked = false;
  const page = {
    viewport: () => ({ width: 1280, height: 800 }),
    evaluate: async () => { asked = true; return { width: 1, height: 1 }; },
  };
  const vp = await liveViewport(page);
  assert.deepEqual(vp, { width: 1280, height: 800 });
  assert.equal(asked, false, 'If one is already available, skip the extra evaluate round trip');
});

test('When emulation is removed (viewport is null), use the size measured from the page', async () => {
  const page = {
    viewport: () => null,
    evaluate: async () => ({ width: 960, height: 620 }),
  };
  assert.deepEqual(await liveViewport(page), { width: 960, height: 620 });
});

test('Fall back to the constant only when measuring fails, and do not throw', async () => {
  const page = { viewport: () => null, evaluate: async () => { throw new Error('The page crashed'); } };
  assert.deepEqual(await liveViewport(page), { width: 1280, height: 800 });
});

test('The screenshot and hit detection must derive the same scale: otherwise clicks are all offset', async () => {
  // 这是这组测试的重点:两边**共用一个尺寸来源**。各自回退常量时，
  // 960 宽的面板上截图按 1280 算，模型报的坐标反算回去会横向偏 33%。
  const panel = { width: 960, height: 620 };
  const page = { viewport: () => null, evaluate: async () => panel };
  const fromView = scaleOf(await liveViewport(page));
  const fromHit = scaleOf(await liveViewport(page));
  assert.equal(fromView, fromHit);
  assert.equal(fromView, 800 / 960, 'The long side is the width, 960, so the scale should be computed from 960');
});

test('The clip of captureView follows the measured size, so it never goes out of bounds', async () => {
  // clip 比真实视口大时 puppeteer 会打开 captureBeyondViewport,那会把设备指标
  // 仿真套回去 —— 正是用户操作面板时画面错位的直接原因
  let clip;
  const page = {
    viewport: () => null,
    waitForFunction: async () => {},
    evaluate: async (fn) => (typeof fn === 'function' && fn.length === 0
      ? { width: 960, height: 620 }
      : { items: [], total: 0, url: 'u', title: 't' }),
    screenshot: async (o) => { clip = o.clip; return 'ZmFrZQ=='; },
  };
  const out = await captureView(page);
  assert.equal(clip.width, 960, 'The clip width must be the measured 960, not the constant 1280');
  assert.equal(clip.height, 620);
  assert.equal(out.image.width, 800);
  assert.equal(out.image.height, Math.round(620 * (800 / 960)));
});
