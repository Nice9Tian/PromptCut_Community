import puppeteer from 'puppeteer';
import path from 'path';
import fsSync from 'node:fs';
import { launchHealthyChrome } from './chrome-health.mjs';

/**
 * 逐帧导出 —— beginFrame 后端。
 *
 * # 为什么换掉虚拟时间那一套
 *
 * 原来的做法(已归档到 scripts/archive/export-frames-virtual-time.mjs)是 CDP 虚拟时间推一格,
 * 再用 `page.screenshot` 截图。慢不在编码:同一状态下截 1×1 的小图 66.7ms、截全屏 85ms ——
 * 截多大几乎一样慢,钱花在「为了截图让 Chrome 出一帧」上,外加截图时临时放开虚拟时间那一整套往返。
 *
 * 这里改用 chrome-headless-shell 的 `HeadlessExperimental.beginFrame`:**帧时间由我们给**,
 * 一拍里跑完 rAF + 画 + 截图,不再需要虚拟时间。实测(docs/archive/topics/render-rebuild-plan.md 阶段 1):
 *   - demo 全长 1800 帧:旧 107.7 ms/帧 → 这里 26.9 ms/帧,约 4 倍;
 *   - 和旧管线逐帧对账:两边各自两趟都是 1800/1800,彼此不一致的帧全部来自系统字体回退(已在主题里修掉),
 *     不是出帧方式的差异;
 *   - 旧管线自己偶发不确定(一次 600 帧两趟 13 帧不同),这里四次两两比对全部相同。
 *
 * # 每帧的步骤,和旧管线逐条对应
 *
 *   旧                                                  这里
 *   __pcSetT                                            同
 *   setVirtualTimePolicy(pauseIfNetworkFetchesPending)   等网络(Network 域数在路上的请求,清零才往下)→ 排空 → beginFrame() → 等网络
 *   settle():放 0.001ms 虚拟时间                        页面内 setTimeout(0),直到 __pcMutationCount 不再变
 *   __pcSyncAnims → settle → 等图片 decode / __pcFrameReady  同(合并成两次页面内调用)
 *   page.screenshot + 截图时切 advance                   beginFrame({ screenshot })
 *   预热 3 帧 → __pcRestartCards → 再丢 1 帧              同
 *
 * **等网络那一步不能省**:scene-3d 在提前挂载的那一帧动态 `import("three")`,不等它回来,三维画面
 * 晚一帧出现(实测第 119 帧 32 万像素不同);补上之后逐字节一致。旧管线靠 pauseIfNetworkFetchesPending
 * 隐式做了这件事。
 *
 * # 页面时钟
 *
 * performance.now / rAF 仍由 src/kernel/exportClock.ts 钉到 __pcExportMs;随机数、墙上时钟、crypto
 * 由 src/kernel/pinEntropy.ts 钉死。beginFrame 给的帧时间只要求单调递增,画面不读它。
 *
 * # 依赖
 *
 * 需要 chrome-headless-shell(`HeadlessExperimental` 域只在它里面有)。开发机上 puppeteer 默认就装;
 * 桌面安装包由 desktop/scripts/prepare-runtime.mjs 一起拷进 runtime/chrome。
 * 锁死版本:这是实验性 CDP 域,升级 Chrome 前先跑一遍 scripts/verify-determinism.mjs。
 */

/** 一拍的名义间隔(ms)。帧时间只要单调递增,取多少不影响画面 —— 画面读的是 __pcExportMs */
const FRAME_INTERVAL = 1000 / 60;

const BASE_CHROME_ARGS = [
  // Windows headless-shell can still own a blank native window. Keep both
  // startup and every subsequently created target outside the desktop.
  '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check',
  // beginFrame 的前提:渲染器不再自己出帧,每一帧都等我们发 BeginFrame
  '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw',
  '--hide-scrollbars',
  // 软件光栅化:GPU 光栅化在旋转/缩放的抗锯齿边缘上两次不完全一致(实测每帧差十几个像素、幅度 ≤ 8/255)
  '--disable-gpu', '--disable-gpu-rasterization', '--disable-gpu-compositing',
  '--font-render-hinting=none', '--force-device-scale-factor=1',
  // 关掉部分光栅化:上一帧的截图会改变合成器下一帧的失效区边界,同一份几何被光栅成两个样子
  '--disable-partial-raster',
  // 全部动画走主线程:合成器线程上的动画在截图那帧会按自己的钟多走半格
  '--disable-threaded-animation',
  // 上面那串 --disable-gpu* 会把 WebGL 一起关死(getContext 返回 null,three.js 卡渲成空画布且不报错);
  // 这个标志打开 SwiftShader 软件 WebGL,同一个三角形连画三趟逐字节相同
  '--enable-unsafe-swiftshader',
];

/**
 * 要不要关 Chrome 的沙箱(`docs/plan/hosted-render-contract.md` 第 7.3 节;任务书「root 或容器里 Chrome 自动带沙箱参数」):
 * Chrome 拒绝以 root 带沙箱启动,容器里多半也没有它要的用户命名空间。只在 **Linux** 上判 —— Windows、macOS 一律不加,
 * 桌面版的启动参数与原来逐项相同。三种情况回原因,否则回 null:
 *   - `PROMPTCUT_CHROME_NO_SANDBOX=1`(显式要求);设成 `0` 则无论如何不加;
 *   - 进程以 root 运行(`getuid() === 0`);
 *   - 在容器里(存在 `/.dockerenv` 或 `/run/.containerenv`)。
 * 参数都能注入,单测不用真的换平台。
 */
export function noSandboxReason({ platform = process.platform, env = process.env, getuid = process.getuid?.bind(process), exists = fsSync.existsSync } = {}) {
  if (platform !== 'linux') return null;
  if (env.PROMPTCUT_CHROME_NO_SANDBOX === '0') return null;
  if (env.PROMPTCUT_CHROME_NO_SANDBOX === '1') return 'env';
  let uid = null;
  try { uid = typeof getuid === 'function' ? getuid() : null; } catch { uid = null; }
  if (uid === 0) return 'root';
  try { if (exists('/.dockerenv') || exists('/run/.containerenv')) return 'container'; } catch { /* 查不了就当不在容器里 */ }
  return null;
}

/**
 * 这一次启动 Chrome 用的参数:固定的那一串,加(仅 Linux 的 root / 容器)`--no-sandbox`,再加排查用的
 * `PC_CHROME_ARGS="--flag-a --flag-b"`。每次启动现算,不在模块载入时定死(环境变量可以晚于载入才设)。
 */
export function chromeLaunchArgs(options = {}) {
  const env = options.env ?? process.env;
  return [
    ...BASE_CHROME_ARGS,
    ...(noSandboxReason(options) ? ['--no-sandbox'] : []),
    // 实验/排查用:PC_CHROME_ARGS="--flag-a --flag-b" 追加启动参数
    ...(env.PC_CHROME_ARGS ? env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
  ];
}

/**
 * 每个新文档加载前注入。挡掉 Vite 的 HMR / 心跳(它们会一直挂着网络请求),再放毛玻璃遮罩那一套。
 *
 * `__bfSettle`(排空)、`__pcCreateSnapshot`(生成 HTML 快照)和素材装载器(`__pcHideFrameMedia` /
 * `__pcPrepareFrameMedia`)不在这里了:它们是页面 bundle 的一部分,见 `src/render/snapshotSettle.ts`、
 * `src/render/createSnapshot.ts`、`src/render/frameMedia.ts`,由 `ExportView` / `StageView` 挂上
 * (J1)。留在这里的只有 puppeteer 专用、页面自己用不着的东西。
 */
function PAGE_PRELUDE() {
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    if (typeof input === 'string' && input.includes('__vite_ping')) {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return originalFetch.call(window, input, init);
  };
  class MockWebSocket extends EventTarget {
    constructor() { super(); this.readyState = 1; setTimeout(() => this.dispatchEvent(new Event('open')), 10); }
    send() {}
    close() {}
  }
  window.WebSocket = MockWebSocket;
  window.location.reload = () => console.log('Intercepted location.reload');
  /*
   * 毛玻璃遮罩(只渲卡片的导出用,见 server/export-compose.mjs 的 mask)。
   *
   * 卡片的玻璃是 backdrop-filter:blur,模糊的是它**背后**的东西。页面只渲卡片时背后是透明的,
   * 视频由 ffmpeg 事后垫进去 —— 玻璃就成了一块只带底色、不模糊视频的膜。要把模糊补回来,ffmpeg 得知道
   * 玻璃在画面上的确切形状:位置、缩放旋转三维、圆角、被祖先的 opacity 淡到几成、被谁裁掉。
   * 这些自己算很容易漏,所以让 Chrome 画:这一帧截完卡片之后,临时把舞台上除玻璃以外的东西全藏起来、
   * 玻璃本身涂成纯白,再截一张 —— 白的地方就是玻璃,alpha 就是它的覆盖度 × 不透明度。截完原样还回去。
   *
   * 还原时不能惊动任何动画:
   *   - 全程不碰 transition-property(改它会取消正在跑的 CSS 过渡),只把 duration / delay 压成 0,
   *     这样改值不会起新的过渡;
   *   - 撤掉时分两步:先撤掉覆盖、保留「duration 0」再强制算一次样式(值变回去也不起过渡),再整个删掉;
   *   - 动画(Motion 的 WAAPI、CSS animation)在层叠里低于 !important 的作者样式,覆盖期间被压住,撤掉即恢复;
   *   - 只有本来就可见的玻璃才标记:原本 visibility:hidden 的不能被这里的规则拉出来。
   * 祖先上的 filter 不动:去掉它会改变绝对定位后代的包含块,可能把玻璃挪位;代价是带强调阴影的玻璃卡,
   * 遮罩边上会多一圈淡淡的影子(模糊略微溢出玻璃边)。
   */
  const GLASS_HOLD = '#root *, #root *::before, #root *::after { transition-duration: 0s !important; transition-delay: 0s !important; }';
  const GLASS_ON = GLASS_HOLD + `
    #root *, #root *::before, #root *::after { visibility: hidden !important; }
    #root [data-bf-glass] { visibility: visible !important; background: #fff !important; border-color: #fff !important;
      box-shadow: none !important; outline: none !important; filter: none !important; backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important; color: transparent !important; text-shadow: none !important; }
    #root [data-bf-glass] *, #root [data-bf-glass]::before, #root [data-bf-glass]::after { visibility: hidden !important; }`;
  window.__bfGlassOn = () => {
    const root = document.getElementById('root');
    if (!root) return null;
    const els = [];
    const blurs = [];
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (!bf || bf === 'none' || cs.visibility !== 'visible') continue;
      els.push(el);
      const m = /blur\(([\d.]+)px\)/.exec(bf);
      if (m) blurs.push(parseFloat(m[1]));
    }
    if (!els.length) return null;
    for (const el of els) el.setAttribute('data-bf-glass', '');
    const st = document.createElement('style');
    st.id = '__bf_glass';
    st.textContent = GLASS_ON;
    document.head.appendChild(st);
    window.__bfGlassEls = els;
    return { count: els.length, blurs };
  };
  window.__bfGlassOff = () => {
    const st = document.getElementById('__bf_glass');
    if (!st) return;
    st.textContent = GLASS_HOLD;
    void document.body.offsetHeight;
    st.remove();
    for (const el of window.__bfGlassEls || []) el.removeAttribute('data-bf-glass');
    window.__bfGlassEls = null;
    void document.body.offsetHeight;
  };
}

/**
 * 开一个受帧控制的空白页(`Target.createTarget({ enableBeginFrameControl: true })`,窗口放在屏幕外)。预渲染每一趟都从这里开页;
 * 托管方渲染服务的启动自检(`server/hosted-render/selfcheck.mjs`)也走这一条,所以「自检过了、工作进程却开不了页」不会再出现。
 *
 * 只有 chrome-headless-shell 认这组参数:完整版的 Chrome / Chromium(即使以无头方式起)对不带 `newWindow` 的 `left` / `top`
 * 回 `Target position can only be set for new windows`,而且没有 `HeadlessExperimental.beginFrame`,受帧控制的出帧整个做不了。
 * 所以渲染节点必须用 chrome-headless-shell,版本由仓库锁定的 puppeteer 决定(`expectedHeadlessShellVersion()`)。
 */
export async function openFrameTarget(browser) {
  const bs = await browser.target().createCDPSession();
  let targetId;
  try {
    ({ targetId } = await bs.send('Target.createTarget', { url: 'about:blank', enableBeginFrameControl: true, left: -32000, top: -32000, width: 1920, height: 1080, focus: false }));
  } finally {
    await bs.detach().catch(() => {});
  }
  const target = await browser.waitForTarget((t) => t._targetId === targetId, { timeout: 30000 });
  return target.page();
}

/**
 * 在一个起好的浏览器里走一遍预渲染的开页与出帧:开受帧控制的页、发 `beginFrame` 截一帧。成功回 `{ ok: true, bytes }`(那一帧 PNG 的字节数),
 * 失败回 `{ ok: false, stage: 'open' | 'frame', detail }`。自检用;不改任何渲染路径。
 */
export async function probeFramePath(browser, { timeoutMs = 30000 } = {}) {
  let page = null;
  let stage = 'open';
  const work = (async () => {
    page = await openFrameTarget(browser);
    stage = 'frame';
    const client = await page.createCDPSession();
    await client.send('Page.enable');
    await page.evaluate(() => { document.documentElement.style.background = '#204060'; });
    let tick = 1000;
    for (let i = 0; i < 8; i += 1) {
      const out = await client.send('HeadlessExperimental.beginFrame', { frameTimeTicks: (tick += FRAME_INTERVAL), interval: FRAME_INTERVAL, screenshot: { format: 'png' } });
      if (out?.screenshotData) return { ok: true, bytes: Buffer.from(out.screenshotData, 'base64').length };
    }
    return { ok: false, stage: 'frame', detail: 'beginFrame 连发 8 拍都没有交回画面' };
  })();
  let timer = null;
  try {
    return await Promise.race([
      work,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, stage, detail: `${timeoutMs / 1000} 秒没有结果` }), timeoutMs); }),
    ]);
  } catch (err) {
    return { ok: false, stage, detail: String(err?.message ?? err).split('\n')[0].slice(0, 300) };
  } finally {
    clearTimeout(timer);
    try { await page?.close(); } catch { /* 浏览器随后就关 */ }
  }
}

/** 仓库锁定的 puppeteer 配的 chrome-headless-shell 版本号(如 `152.0.7977.75`);读不到回 null */
export async function expectedHeadlessShellVersion() {
  try { return await headlessShellBuildId(); } catch { return null; }
}

/**
 * 在一个已经起好的浏览器里开一个**全新的、受帧控制的 page**,导航到导出页、等页面就绪。
 *
 * 为什么每趟都开新 page:页面上有动画锚点、已挂载的卡片、推到片尾的状态,原地再渲一趟拿到的不是
 * 第 0 帧的画面。新 page 是一个全新的 renderer,和全新起一个浏览器等价。
 * 页面必须用 `Target.createTarget({ enableBeginFrameControl: true })` 开 —— `browser.newPage()`
 * 开出来的页面不受帧控制,beginFrame 对它无效。
 */
async function newSession(browser, url) {
  const page = await openFrameTarget(browser);
  page.on('console', (msg) => { if (msg.type() !== 'debug') console.log('PAGE LOG:', msg.text()); });
  const client = await page.createCDPSession();
  await client.send('Page.enable');

  /*
   * 等网络:对应旧管线的 pauseIfNetworkFetchesPending。请求一直不回来(比如某个长连接)就显式报错,
   * 假死更糟。事件驱动:没有请求在路上时立刻返回,不白等。
   */
  /** requestId → 这条请求是什么,超时报错时要说得出是谁挂着 */
  const inflight = new Map();
  let waiters = [];
  const drained = () => {
    if (inflight.size) return;
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
  };
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent', (e) => {
    /*
     * <video>/<audio> 的媒体流不算。一段大视频挂在页面上,它的请求会一直开着边播边取,
     * 永远等不到 loadingFinished —— 算进来的话每帧都要白等满 30 秒然后报错(实测一个项目挂了
     * 20 段视频、最大 265 MB,导出一帧都出不来)。视频这一层有它自己的等法:ExportView 的
     * __pcFrameReady 逐层等 seek 到位,这里再等一遍既不需要也等不到。
     */
    if (e.type === 'Media') return;
    /*
     * `blob:` 脚本也不算(R9):GL Worker 由一个 blob 引导脚本起,Worker 主脚本请求的收尾事件报在 Worker 自己的
     * target 上,页面的 Network 域里永远等不到 loadingFinished。blob 是本地内存,本来就没有「在路上」这回事。
     */
    if (String(e.request?.url || '').startsWith('blob:')) return;
    inflight.set(e.requestId, `${e.type || '?'} ${String(e.request?.url || '').slice(0, 120)}`);
  });
  for (const ev of ['Network.loadingFinished', 'Network.loadingFailed', 'Network.requestServedFromCache']) {
    client.on(ev, (e) => { inflight.delete(e.requestId); drained(); });
  }
  const waitNet = (ms = 30000) => (inflight.size === 0 ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `${inflight.size} 个网络请求 ${ms / 1000} 秒还没回来:页面可能挂着一直不结束的请求。`
      + `前几个:${[...inflight.values()].slice(0, 3).join(' | ')}`
    )), ms);
    waiters.push(() => { clearTimeout(timer); resolve(); });
  }));

  let tick = 1000;
  const beginFrame = (extra = {}) => client.send('HeadlessExperimental.beginFrame', {
    frameTimeTicks: (tick += FRAME_INTERVAL), interval: FRAME_INTERVAL, ...extra,
  });

  // 页面侧带超时的 evaluate(给调用方兜底用;虚拟时间没了以后页面自己的定时器也可靠了)
  const evalWithTimeout = (fn, ms) => Promise.race([
    page.evaluate(fn).catch(() => {}),
    new Promise((r) => setTimeout(r, ms)),
  ]);

  /** 等 window.__pcReady。受帧控制的页面不自己出帧,等的时候要一直发空拍(不画不截) */
  const waitReady = async () => {
    const t0 = Date.now();
    for (;;) {
      await beginFrame({ noDisplayUpdates: true }).catch(() => {});
      if (await page.evaluate(() => window.__pcReady === true).catch(() => false)) return;
      if (Date.now() - t0 > 60000) throw new Error('导出页 60 秒没就绪(window.__pcReady 一直不是 true)');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  await page.evaluateOnNewDocument(PAGE_PRELUDE);
  console.log(`Navigating to ${url}...`);
  /*
   * 导航失败(端口上没有服务器之类)Page.navigate 不抛错,只在返回值里带 errorText,页面停在 Chrome 的
   * 错误页上。不看它的话 waitReady 要白等满 60 秒,报的还是一句像页面代码出了问题的话。
   * 地址里常带整份项目 JSON(?timeline=data:…),太长时报错只留源和路径。
   */
  const { errorText } = await client.send('Page.navigate', { url });
  if (errorText) {
    const u = new URL(url);
    const where = url.length > 120 ? `${u.origin}${u.pathname}…` : url;
    throw new Error(`打不开导出页 ${where}:${errorText} —— 这个地址上的 dev server 起了吗?`);
  }
  console.log('Waiting for window.__pcReady...');
  await waitReady();

  return {
    page, client, beginFrame, waitNet, evalWithTimeout,
    /**
     * 原地换一个项目再等就绪 —— 不重新导航。只在 reset() 里、在**全新 page** 上用;
     * 在用过的页面上原地换项目,动画锚点和已挂载的卡片都是上一趟的,拿到的不是第 0 帧。
     */
    async loadProject(project, options = {}) {
      await page.evaluate((p, o) => window.__pcLoadProject(p, o), project, options);
      await waitReady();
    },
  };
}

/**
 * puppeteer 这一版要的 chrome-headless-shell 版本号。从 puppeteer-core 的 revisions 表里读 ——
 * 和 desktop/scripts/prepare-runtime.mjs 读 Chrome 版本是同一个来源,两边对得上。
 */
async function headlessShellBuildId() {
  const { createRequire } = await import('node:module');
  const require_ = createRequire(import.meta.url);
  const pkgDir = path.dirname(require_.resolve('puppeteer-core/package.json'));
  for (const rel of ['lib/esm/puppeteer/revisions.js', 'lib/cjs/puppeteer/revisions.js', 'lib/puppeteer/revisions.js']) {
    const f = path.join(pkgDir, rel);
    if (!fsSync.existsSync(f)) continue;
    const src = fsSync.readFileSync(f, 'utf8');
    const m = src.match(/['"]chrome-headless-shell['"]\s*:\s*['"]([^'"]+)['"]/) || src.match(/\bchrome\s*:\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  }
  throw new Error('读不到 puppeteer-core 的 chrome-headless-shell 版本号');
}

/** 同一个进程里并发开 bakery(分片导出)时只装一次 */
let installingShell = null;

/** 把 chrome-headless-shell 装进 puppeteer 的缓存目录(桌面版 = runtime/chrome) */
async function installHeadlessShell() {
  installingShell ??= (async () => {
    const os = await import('node:os');
    const { install, Browser, detectBrowserPlatform } = await import('@puppeteer/browsers');
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
    const buildId = await headlessShellBuildId();
    console.log(`安装 chrome-headless-shell@${buildId} 到 ${cacheDir}(约 100 MB,只装这一次)…`);
    await install({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform: detectBrowserPlatform() });
  })();
  try {
    await installingShell;
  } finally {
    installingShell = null;
  }
}

const DEFAULT_URL = 'http://127.0.0.1:5190/?export=1';

/**
 * 开一个「预渲染间」:起浏览器、导航到导出页、等页面就绪。
 *
 * 单独拆出来是为了让常驻进程(scripts/render-worker.mjs)复用同一个浏览器:冷启动要几秒,
 * 复用只要换一个 page。复用姿势:每趟渲帧之前调一次 `await bakery.reset(project, url)`,然后 bakeFrames。
 */
export async function openBakery(opts = {}) {
  const url = opts.url || DEFAULT_URL;

  console.log('Launching Puppeteer (chrome-headless-shell)...');
  const sandboxOff = noSandboxReason();
  if (sandboxOff) console.log(`Chrome 以 --no-sandbox 启动(原因:${sandboxOff})`);
  const launch = () => puppeteer.launch({ headless: 'shell', protocolTimeout: 60000, args: chromeLaunchArgs() });
  let browser;
  try {
    browser = await launchHealthyChrome({ launch });
  } catch (e) {
    if (!/could not find/i.test(e?.message || '')) throw e;
    /*
     * 没找到就现装一份。为什么需要这一步:更新补丁只带 runtime/app(Node 那半边),不带 runtime/chrome;
     * 从 0.3.x 打补丁升上来的用户手里只有完整 Chrome、没有 headless-shell,导出会直接起不来。
     * 装进 PUPPETEER_CACHE_DIR(桌面版 = runtime/chrome),只装这一次;装不上(没网)就报清楚该怎么办。
     */
    console.warn('没找到 chrome-headless-shell,尝试自动安装……');
    try {
      await installHeadlessShell();
    } catch (e2) {
      throw new Error(
        '导出需要 chrome-headless-shell,没找到,自动安装也失败了(' + (e2?.message || e2) + ')。' +
        '桌面版请用完整安装包重装一次;开发机上跑 `npx puppeteer browsers install chrome-headless-shell`。原始错误:' + e.message,
      );
    }
    browser = await launchHealthyChrome({ launch });
  }

  let session;
  try {
    session = await newSession(browser, url);
  } catch (error) {
    // No caller owns this browser until the bakery object is returned.
    await browser.close().catch(() => {});
    throw error;
  }
  const bakery = {
    browser,
    ...session,
    /**
     * 换一趟新的:开一个全新 page(可选地把项目灌进去),换掉 bakery 上的 page/client,再关掉旧 page。
     * 旧 page 必须关:每趟漏一个不关,renderer 进程线性泄漏(这台机器多开 Chrome 复现过 0xC0000142)。
     * `nextUrl` 换一个导出页地址再开 —— 常驻 worker 每趟渲的是不同的隔离项目,项目由页面自己去 fetch。
     */
    async reset(project, nextUrl, options = {}) {
      // 换页之前的钩子(c10a 第 9 节:预渲染小尺寸在要扔掉的这一页上画);出错不挡换页
      if (typeof bakery.beforeReset === 'function') { try { await bakery.beforeReset(bakery); } catch { /* 小尺寸失败不挡原尺寸 */ } }
      const old = bakery.page;
      const s = await newSession(browser, nextUrl || url);
      if (project) await s.loadProject(project, options);
      Object.assign(bakery, s);
      await old.close();
    },
    /**
     * 备用页:提前开好一个**全新的**、停在空项目上的 page。来活时 resetWith 把项目原地灌进去。
     *
     * 为什么值得:一趟的准备里,新开 page + 导航 + 加载整张模块图 + 等就绪约 310 ms,而把项目灌进
     * 一个已经就绪的新页只要 3~4 ms(实测,rank-bars / mu-number-ticker / particles)。
     * 为什么不破坏确定性:备用页和现开的页一样是全新的、从没推过帧,灌项目走的是 loadProject
     * 这条「只在全新 page 上用」的路 —— 实测两条路渲同一帧逐字节相同(3 张卡 × 3 次,9/9)。
     */
    spare: null,
    preload(emptyUrl) {
      if (!bakery.spare) {
        bakery.spare = newSession(browser, emptyUrl);
        bakery.spare.catch(() => {}); // 备用页开失败不报,resetWith 会现开一个兜底
      }
      return bakery.spare;
    },
    /**
     * 扔掉备用页。卡片源码一改,备用页里加载的就是旧模块 —— 拿它灌下一个项目渲出来的是旧卡片,
     * 而且不报错(见 render-worker 的 invalidate)。
     */
    dropSpare() {
      const p = bakery.spare;
      bakery.spare = null;
      p?.then((s) => s?.page?.close(), () => {}).catch(() => {});
    },
    /** 用备用页(没有就现开一个空项目页)换一趟新的,再把 project 灌进去 */
    async resetWith(project, emptyUrl) {
      if (typeof bakery.beforeReset === 'function') { try { await bakery.beforeReset(bakery); } catch { /* 同上 */ } }
      const old = bakery.page;
      let s = null;
      if (bakery.spare) {
        const p = bakery.spare;
        bakery.spare = null;
        s = await p.catch(() => null);
      }
      if (!s) s = await newSession(browser, emptyUrl);
      await s.loadProject(project);
      Object.assign(bakery, s);
      await old.close();
    },
    /** 旧管线里「放开虚拟时间」的接口。这里没有虚拟时间,保留成空操作,老调用方不用改 */
    releaseClock: async () => {},
    close: () => browser.close(),
  };
  return bakery;
}

export { DEFAULT_URL };
