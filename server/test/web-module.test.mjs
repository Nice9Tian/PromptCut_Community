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

test('长边缩到 800,短边等比', () => {
  assert.equal(scaleOf({ width: 1280, height: 800 }), 800 / 1280);
  // 竖着的视口:长边是高,按高算
  assert.equal(scaleOf({ width: 600, height: 1200 }), 800 / 1200);
});

test('视口比 800 还小时原样给,不放大', () => {
  // 放大只会让图更大更贵,一个像素的信息都不会多
  assert.equal(scaleOf({ width: 640, height: 480 }), 1);
  assert.equal(scaleOf({ width: 800, height: 600 }), 1);
});

test('两个轴共用一个 scale —— 宽高比不变', () => {
  const vp = { width: 1280, height: 800 };
  const s = scaleOf(vp);
  const img = { w: vp.width * s, h: vp.height * s };
  assert.ok(Math.abs(img.w / img.h - vp.width / vp.height) < 1e-9,
    '图和视口的宽高比必须一致,否则模型报的坐标反算回去两个轴会偏得不一样');
});

// ── 截图不许动视口 ────────────────────────────────────────────────────
// 这条是回归测试。上一版为了缩放去改 deviceScaleFactor,有头窗口下那是一次真实的
// 窗口 resize —— 页面正在跳转时会挂住,实测 web_view 卡满 45 秒超时才返回。换成
// clip.scale 之后视口一动不动。视口一旦被动过,elementFromPoint 的坐标系就跟着变,
// 命中检测会集体偏,所以这件事必须锁死。

test('captureView 全程不调 setViewport,缩放靠 clip.scale', async () => {
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
    'setViewport 一次都不该调 —— 有头窗口下那是真实 resize,跳转中会挂');
  const shot = calls.find((c) => c.screenshot).screenshot;
  assert.equal(shot.clip.scale, 800 / 1280, '缩放必须交给 clip.scale');
  assert.equal(shot.clip.width, 1280);
  assert.equal(shot.clip.height, 800);
  assert.equal(out.image.width, 800);
  assert.equal(out.image.height, 500, '1280x800 长边缩到 800,短边等比是 500');
});

test('captureView 等页面 readyState,但等不到也照样截', async () => {
  let waited = false;
  const page = {
    viewport: () => ({ width: 1280, height: 800 }),
    waitForFunction: async () => { waited = true; throw new Error('timeout'); },
    evaluate: async () => ({ items: [], total: 0, url: 'u', title: 't' }),
    screenshot: async () => 'ZmFrZQ==',
  };
  const out = await captureView(page);
  assert.ok(waited, '要先等一下加载状态');
  assert.ok(out.__image.base64, '等超时了也得给出图 —— 半张图也比一句超时有用');
});

test('__image 的形状必须是 harness 认的那个', async () => {
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

test('还没截屏就报坐标:告诉它先 web_view', () => {
  const msg = explain({ ok: false, reason: 'no_snapshot' });
  assert.match(msg, /web_view/);
});

test('点在空白处:说清那里是什么,并给两条出路', () => {
  const msg = explain({ ok: false, reason: 'empty', saw: '这是一段正文' });
  assert.match(msg, /这是一段正文/);
  assert.match(msg, /u/, '要提示可以用 u 直接指定');
});

test('多个候选:每条都带可直接调用的 u', () => {
  const msg = explain({
    ok: false, reason: 'ambiguous',
    cands: [
      { u: 'e7', n: 'CSS', t: 'button', b: [183, 79, 229, 107], d: 0 },
      { u: 'e6', n: 'HTML', t: 'button', b: [128, 79, 183, 107], d: 2 },
    ],
  });
  assert.match(msg, /u="e7"/);
  assert.match(msg, /u="e6"/);
  assert.match(msg, /web_click/, '要明说用 web_click 指定,别让它猜下一步');
});

test('被上层盖住的候选要标出来', () => {
  const msg = explain({
    ok: false, reason: 'ambiguous',
    cands: [{ u: 'e3', n: '下载', t: 'a', b: [0, 0, 10, 10], d: 0, stacked: true }],
  });
  assert.match(msg, /盖住/, '压在弹窗底下的元素直接点会被拦截,必须提醒');
});

test('expect 对不上:把 expect 原样回显,好让模型知道自己找的是什么', () => {
  const msg = explain({
    ok: false, reason: 'expect_mismatch', expect: '登录',
    cands: [{ u: 'e1', n: '注册', t: 'a', b: [0, 0, 10, 10], d: 4 }],
  });
  assert.match(msg, /登录/);
  assert.match(msg, /注册/);
});

test('命中成功时不产生话术', () => {
  assert.equal(explain({ ok: true, pick: { u: 'e1' } }), null);
});

// ── 动作层的参数校验 ──────────────────────────────────────────────────

test('web_click 既没给 u 也没给坐标:当场拒绝,不去碰页面', async () => {
  // page 传 null:一旦实现里先去动页面再校验,这里会 TypeError 而不是拿到干净的错误
  const r = await session.click(null, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /u/);
  assert.match(r.error, /x,y/);
});

test('web_click 只给了 x 没给 y 也算没给坐标', async () => {
  const r = await session.click(null, { x: 100 });
  assert.equal(r.ok, false);
});

test('web_type 找不到编号时,明说编号会随截图失效', async () => {
  const page = { $: async () => null };
  const r = await session.type(page, { u: 'e99', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /web_view/, '要告诉它重新截屏,不然它会拿着同一个死编号反复试');
});

test('web_click 拿到不存在的编号时同样说清原因', async () => {
  const page = { $: async () => null };
  const r = await session.click(page, { u: 'e99' });
  assert.equal(r.ok, false);
  assert.match(r.error, /e99/);
  assert.match(r.error, /web_view/);
});

// ── 串行队列 ──────────────────────────────────────────────────────────

test('enqueue 严格串行:后一个必须等前一个结束', async () => {
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

test('前一个抛错不会卡死队列', async () => {
  await session.enqueue(async () => { throw new Error('炸了'); }).catch(() => {});
  const r = await session.enqueue(async () => 'still alive');
  assert.equal(r, 'still alive');
});

// ── 交接 ──────────────────────────────────────────────────────────────

test('web_handoff 把窗口挪出来,并明确要求 agent 停下来', async () => {
  const calls = [];
  const inst = {
    cdp: { send: async (m, p) => { calls.push({ m, s: p?.bounds?.windowState, left: p?.bounds?.left }); } },
    page: { bringToFront: async () => calls.push({ m: 'front' }) },
    windowId: 1,
  };
  const r = await session.handoff(inst, { reason: 'B 站扫码登录' });
  assert.equal(r.ok, true);
  assert.equal(r.visible, true);
  assert.match(r.message, /B 站扫码登录/);
  assert.match(r.message, /不要继续调工具/, 'agent 必须停下来等人,不能自己往下点');

  // 实测 Windows 上直接挪回屏幕内窗口仍是隐藏的:必须先 minimized 再 normal(见 showWindow 注释)
  assert.equal(calls[0].s, 'minimized', '第一步必须是 minimized,否则窗口位置对了也看不见');
  assert.ok(calls.some((c) => c.s === 'normal'), '要还原成 normal');
  const placed = calls.find((c) => typeof c.left === 'number');
  assert.ok(placed && placed.left >= 0, '要有一次把位置摆到屏幕内');
  assert.ok(calls.some((c) => c.m === 'Emulation.clearDeviceMetricsOverride'),
    '交给人时要解除视口仿真,不然窗口拉大画面不跟着长');
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
      `setWindowBounds 同时给了 windowState=${c.s} 和 left=${c.left} —— 位置会被 CDP 丢掉`);
  }
}

test('web_handoff hide:true 把窗口藏回屏幕外', async () => {
  const calls = [];
  const inst = {
    cdp: { send: async (m, p) => { calls.push({ m, s: p?.bounds?.windowState, left: p?.bounds?.left }); } },
    page: { bringToFront: async () => {}, setViewport: async () => {} },
    windowId: 1,
  };
  const r = await session.handoff(inst, { hide: true });
  assert.equal(r.visible, false);
  const placed = calls.find((c) => typeof c.left === 'number');
  assert.ok(placed && placed.left < 0, '藏回去必须是负坐标');
  // 用户在接管期间可能把窗口最大化过,那时 hide 是一次真的状态变更 —— 同样不能和位置一起发
  noStateWithPosition(calls);
});

// ── 热重启后的浏览器接管 ──────────────────────────────────────────────
// 起因是并行的那个会话报的真 bug:dev 下 Vite 一热重启就把 browser.mjs 换掉一份新的,
// 模块级的 instance 归零,**但上一份起的 Chrome 还活着、还握着 out/web-profile**。
// 之后所有 web_* 全部报「被另一个实例占着」,直到手动去杀那个 Chrome。已复现并修掉。
// 这里锁住的是「怎么分辨孤儿和别人正在用的」这条判据 —— 判错了就是替别人把浏览器关了。

test('closeBrowser 对 shared 实例只断开,不替别人关浏览器', async () => {
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
  assert.deepEqual(acts, ['close'], '自己起的就该真关掉');
});

test('接管的实例带 userDataDir,好让 close 顺手清掉过期的端点文件', async () => {
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
  assert.equal(inst.userDataDir, undefined, 'dataDir 传 null 就不落盘,登录态不该留下来');
  assert.equal(inst.shared, false);
  await mod.closeBrowser();
});

// ── 壳模式:agent 的浏览器是 Tauri 主窗口里的子 webview ──────────────────
// 桌面壳给 WebView2 开了 --remote-debugging-port,端口通过 PROMPTCUT_AGENT_CDP 交过来。
// getBrowser 在这个变量存在时 connect 而不是 launch,按初始地址认出 agent 那块;
// 显示 / 隐藏不再动窗口(壳里没有窗口可动),只回 shell 标记让前端 invoke 壳的命令。

function fakeShellPuppeteer(acts, pagesList) {
  return {
    launch: async () => { acts.push('launch'); throw new Error('壳模式不该 launch'); },
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

test('壳模式:按 PROMPTCUT_AGENT_CDP 连调试端口,按注入标记认出 agent 那块(地址早不是初始的了),不 launch', async () => {
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
    assert.equal(inst.shared, true, '浏览器是壳的,关的时候只能断开自己');
    assert.equal(inst.page.url(), 'https://www.bilibili.com/', '认的是带标记的 agent 那块,不是编辑台主页面');
    // 显示 / 隐藏只回标记
    assert.deepEqual(await mod.showWindow(inst), { shell: true });
    assert.deepEqual(await mod.hideWindow(inst), { shell: true });
    await mod.closeBrowser();
    assert.ok(acts.includes('disconnect') && !acts.includes('close'), '壳的浏览器不能被 Node 关掉');
  } finally {
    delete process.env.PROMPTCUT_AGENT_CDP;
    delete process.env.PROMPTCUT_AGENT_URL;
  }
});

test('壳模式:端口连不上就退回 Chrome 那条路', async () => {
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

test('handoff 在壳模式下带 shell 标记,措辞不再说「窗口」', async () => {
  const inst = { shell: true, cdp: { send: async () => {} }, page: { setViewport: async () => {} } };
  const r = await session.handoff(inst, { reason: '登录' });
  assert.equal(r.shell, true);
  assert.equal(r.visible, true);
  assert.match(r.message, /主窗口里/);
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

test('有仿真时直接用仿真尺寸,不去问页面', async () => {
  let asked = false;
  const page = {
    viewport: () => ({ width: 1280, height: 800 }),
    evaluate: async () => { asked = true; return { width: 1, height: 1 }; },
  };
  const vp = await liveViewport(page);
  assert.deepEqual(vp, { width: 1280, height: 800 });
  assert.equal(asked, false, '有现成的就别多一次 evaluate 往返');
});

test('仿真解除(viewport 为 null)时按页面实测尺寸算', async () => {
  const page = {
    viewport: () => null,
    evaluate: async () => ({ width: 960, height: 620 }),
  };
  assert.deepEqual(await liveViewport(page), { width: 960, height: 620 });
});

test('量不出来才退回常量,不抛出去', async () => {
  const page = { viewport: () => null, evaluate: async () => { throw new Error('页面崩了'); } };
  assert.deepEqual(await liveViewport(page), { width: 1280, height: 800 });
});

test('截图和命中检测必须得出同一个 scale —— 否则点击整体偏', async () => {
  // 这是这组测试的重点:两边**共用一个尺寸来源**。各自回退常量时，
  // 960 宽的面板上截图按 1280 算，模型报的坐标反算回去会横向偏 33%。
  const panel = { width: 960, height: 620 };
  const page = { viewport: () => null, evaluate: async () => panel };
  const fromView = scaleOf(await liveViewport(page));
  const fromHit = scaleOf(await liveViewport(page));
  assert.equal(fromView, fromHit);
  assert.equal(fromView, 800 / 960, '长边是宽 960,所以 scale 应当按 960 算');
});

test('captureView 的 clip 跟着实测尺寸走,不会 clip 出界', async () => {
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
  assert.equal(clip.width, 960, 'clip 宽必须是实测的 960,不是常量 1280');
  assert.equal(clip.height, 620);
  assert.equal(out.image.width, 800);
  assert.equal(out.image.height, Math.round(620 * (800 / 960)));
});
