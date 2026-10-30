/**
 * 给 agent 用的浏览器实例。**和渲帧那个是两个东西,不要合并。**
 *
 * 差别不是洁癖,是三条硬冲突:
 *
 * 1. **启动参数相反**。server/bakery/chrome.mjs 那个挂着一整套为字节级可复现调出来的
 *    参数(--disable-gpu-rasterization / --disable-partial-raster / --disable-threaded-animation),
 *    那是为了同一份时间轴导出两次要逐字节一致。网页浏览要的恰恰是正常渲染 —— 站点的
 *    懒加载、动画、GPU 合成都得照常跑,不然看到的画面和用户在自己浏览器里看到的不是一回事。
 * 2. **profile 必须隔离**。浏览要存 cookie 和登录态(B 站扫码登录之后那份 cookie 就是
 *    素材收集要用的),导出要一张白纸。共用 user-data-dir 迟早互相污染。
 * 3. **生命周期不同**。导出和看图是用完就关,浏览是长驻 —— agent 上一轮打开的页面,
 *    下一轮还要接着点。
 *
 * ## 为什么是「有头 + 离屏」而不是 headless
 *
 * 网页操作必然撞上登录、验证码、cookie 同意、付费墙。这些**不该也不能由 agent 代劳**
 * (验证码尤其:那必须是人来点)。headless 没有窗口,撞上了就是死路;有头 + 摆到
 * -32000,-32000 平时看不见,需要人接手时用 CDP 的 Browser.setWindowBounds 把它挪回
 * 屏幕上,处理完再藏回去。实测两个方向都通,见 showWindow / hideWindow。
 *
 * 顺带:headless 更容易被站点当机器人挡掉,渲染也和有头有差异。
 */
import path from 'node:path';
import fs from 'node:fs';

/** 视口固定成这个尺寸。固定是为了图坐标换算是个常数,见 view.mjs 的 scaleOf */
export const VIEWPORT = { width: 1280, height: 800 };

/** 回给模型的图,**长边**缩到这个数,短边等比。等比是关键:拉伸过的图上模型报的坐标没法还原 */
export const IMAGE_LONG_EDGE = 800;

/** 藏窗口的位置。Chrome 允许负坐标,-32000 在任何多屏布局下都在所有屏幕之外 */
const OFFSCREEN = { left: -32000, top: -32000 };

let instance = null;      // { browser, page, cdp, windowId, shared }
let launching = null;     // 并发调用共用同一次启动,别起出两个浏览器来

/** 记谁起的这个浏览器。用来分辨「热重启遗留的孤儿」和「另一个实例正在用」 */
const OWNER_FILE = 'promptcut-owner.json';

function ownerPath(userDataDir) {
  return path.join(userDataDir, OWNER_FILE);
}

function writeOwner(userDataDir) {
  try {
    fs.writeFileSync(ownerPath(userDataDir), JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch { /* 记不上不影响用,只是下次分辨不出孤儿 */ }
}

/**
 * 记录里那个进程还活着吗。活着且不是自己 = 另一个实例正在用。
 *
 * `process.kill(pid, 0)` 只探活不发信号。它抛 EPERM 的意思是**进程在、但没权限动它**
 * (比如换了用户跑),那也算活着 —— 判成死的会让我们把别人的浏览器关掉。
 * 只有 ESRCH(查无此进程)才是真的没了。
 *
 * pid 会被系统回收,所以这个判断不是百分百准。**但它错的方向是安全的**:
 * 回收后的 pid 恰好被别人占用时,我们会把孤儿误判成 shared —— 后果只是 web_close
 * 没杀掉那个浏览器,下一次 getBrowser 会重新接管它,自愈。反过来(把别人正在用的
 * 判成孤儿)才会真的伤人,而那需要对方进程恰好死了,那时它本来就该被接管。
 * 所以这里不再为 pid 回收加复杂度。
 */
function ownerAlive(userDataDir) {
  let pid;
  try {
    ({ pid } = JSON.parse(fs.readFileSync(ownerPath(userDataDir), 'utf8')));
  } catch {
    return false;           // 文件没有或者坏了 —— 当没人认领
  }
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * profile 里那个还活着的 Chrome 的调试端点。没有就返回 null。
 *
 * Chrome 起来时会把 `<port>\n<ws 路径>` 写进 profile 目录的 DevToolsActivePort。
 * 干净退出会删掉它,被杀掉则会留下一个过期的文件 —— 所以拿到了也不能当真,
 * 连不上就当没有。
 */
function debugEndpoint(userDataDir) {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8');
    const [port, wsPath] = raw.trim().split('\n');
    if (!port || !wsPath) return null;
    return `ws://127.0.0.1:${port}${wsPath}`;
  } catch {
    return null;
  }
}

/**
 * 连壳(Tauri 主窗口)里的 agent 子 webview。连不上或找不到那块就返回 null。
 *
 * 一个 WebView2 环境下所有 webview 共用一个调试端点,列出来的 target 里既有编辑台的
 * 主页面也有 agent 这块,靠**初始地址**认:壳建它时用的是 about:blank#promptcut-agent,
 * agent 导航过之后地址会变,所以第一次认出来就记住那个 page 对象,之后不再按地址找。
 */
async function connectShell(pptr, port, initialUrl) {
  let browser;
  try {
    browser = await pptr.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  } catch {
    return null;
  }
  try {
    let page = null;
    // 壳建 webview 和 sidecar 起来是并行的,给它几秒。
    // 认哪一块:壳给 agent 那块每次导航都注入 window.__PROMPTCUT_AGENT__,先按它认
    // (热重启后重连时 agent 早就不在初始地址上了);评估不了的页(崩了、跨域拦着)
    // 再退回按初始地址认。
    for (let i = 0; i < 20 && !page; i++) {
      const pages = await browser.pages();
      for (const p of pages) {
        try {
          if (await p.evaluate(() => window.__PROMPTCUT_AGENT__ === true)) { page = p; break; }
        } catch { /* 这一页评估不了,看下一页 */ }
      }
      if (!page) page = pages.find((p) => p.url() === initialUrl) || null;
      if (!page) await new Promise((r) => setTimeout(r, 250));
    }
    if (!page) {
      await browser.disconnect();
      return null;
    }
    await page.setViewport(VIEWPORT);
    const cdp = await page.createCDPSession();
    // shared: 这个浏览器是壳的,关的时候只断开自己;shell: 显示 / 隐藏要走壳的命令
    return { browser, page, cdp, windowId: null, shared: true, shell: true, userDataDir: undefined };
  } catch {
    try { await browser.disconnect(); } catch { /* 忽略 */ }
    return null;
  }
}

/**
 * 关掉浏览器。**不在这里做**:进程退出时的兜底 —— 那是 Tauri 侧 kill 整棵进程树的活儿
 * (见 desktop/src-tauri/src/lib.rs 的 sidecar pid),这里只管主动关。
 *
 * `shared` 的实例是接管来的、而且原主还活着 —— 那种只断开自己这一头,不能替别人
 * 把浏览器关了。
 */
export async function closeBrowser() {
  const cur = instance;
  instance = null;
  launching = null;
  if (!cur) return;
  try {
    if (cur.shared) await cur.browser.disconnect();
    else await cur.browser.close();
  } catch { /* 已经死了就算了 */ }

  // 实测:干净关掉之后 DevToolsActivePort **不会**被 Chrome 删掉(至少 Windows 上如此)。
  // 留着不会出错 —— 下次 getBrowser 连不上会退回 launch —— 但那是每次会话开头都白花
  // 一个连接往返。自己删掉,让常见路径干净。shared 的不删:那个端点是别人的,还在用。
  if (!cur.shared && cur.userDataDir) {
    try { fs.rmSync(path.join(cur.userDataDir, 'DevToolsActivePort'), { force: true }); } catch { /* 删不掉也无所谓 */ }
  }
}

/**
 * 拿到浏览器和当前页。没起过就起一个。
 *
 * `dataDir` 用来放 profile。传 null 表示用临时目录(测试用),那样登录态不会留下来。
 *
 * ## 为什么要先试着「接管」而不是直接 launch
 *
 * 同一个 user-data-dir 不能被两个 Chrome 同时占。而 dev 下 Vite 一热重启就会把这个
 * 模块换掉一份新的 —— 模块级的 `instance` 归零,**但上一份起的 Chrome 进程还活着、
 * 还握着 profile**。于是之后所有 web_* 全部报「被另一个实例占着」,直到手动去杀那个
 * Chrome。改一次 server/ 下的文件就撞一次,开发期几乎必然遇到。
 *
 * 所以先看 profile 里的 DevToolsActivePort:连得上就直接接管那个浏览器,连不上
 * (文件是上次被杀留下的死记录)再 launch。
 *
 * 接管之后还要分辨两种情况,靠 profile 里的 owner 记录:
 *   - 原主进程已经不在 → **孤儿**,完全接管,web_close 该真的把它关掉;
 *   - 原主还活着 → 另一个 PromptCut 实例正开着,标 `shared`,web_close 只断开
 *     自己这一头,不替别人关浏览器。
 */
export async function getBrowser({ dataDir, puppeteer, executablePath } = {}) {
  if (instance) {
    // 用户可能自己把窗口关了。连不上就重起,不要把死掉的实例交出去
    if (instance.browser.connected !== false) return instance;
    instance = null;
  }
  if (launching) return launching;

  launching = (async () => {
    const pptr = puppeteer || (await import('puppeteer')).default;

    // ── 壳模式:agent 的浏览器是 Tauri 主窗口里的子 webview ──
    // 桌面壳启动时给 WebView2 开了 --remote-debugging-port,端口通过环境变量交过来。
    // 那个端点上列出来的 target 里,初始地址是 PROMPTCUT_AGENT_URL 的那一块就是 agent 的。
    // 显示 / 隐藏由前端 invoke 壳的命令完成(见 showWindow / hideWindow),这里只管连。
    const shellPort = Number(process.env.PROMPTCUT_AGENT_CDP || 0);
    if (shellPort > 0) {
      const inst = await connectShell(pptr, shellPort, process.env.PROMPTCUT_AGENT_URL || 'about:blank#promptcut-agent');
      if (inst) { instance = inst; return inst; }
      // 连不上就照常起 Chrome:壳没把 webview 建起来时至少还有旧路可走
      process.stderr.write(`[web] 连不上壳里的 agent webview(端口 ${shellPort}),退回 Chrome\n`);
    }

    const userDataDir = dataDir ? path.join(dataDir, 'web-profile') : undefined;
    if (userDataDir) fs.mkdirSync(userDataDir, { recursive: true });

    // ── 先试接管 ──
    const endpoint = userDataDir ? debugEndpoint(userDataDir) : null;
    if (endpoint) {
      try {
        const browser = await pptr.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
        const shared = ownerAlive(userDataDir);
        const pages = await browser.pages();
        const page = pages.find((p) => !p.url().startsWith('devtools://')) || await browser.newPage();
        await page.setViewport(VIEWPORT);
        const cdp = await page.createCDPSession();
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        // 孤儿就把 owner 改成自己,免得下一次热重启又把它当成「别人的」
        if (!shared) writeOwner(userDataDir);
        instance = { browser, page, cdp, windowId, shared, userDataDir };
        return instance;
      } catch {
        // 连不上 = DevToolsActivePort 是上次被杀留下的死文件,照常往下 launch
      }
    }

    /*
     * 同一个 user-data-dir 不能被两个 Chrome 同时占。这在正常使用里也会撞上:
     * 用户开了两个 PromptCut(或者一边跑着 scripts/web-check.mjs),两边的 agent
     * 都想上网。puppeteer 原样抛出来的是一句英文天书,用户看不懂也不知道该干什么,
     * 所以在这里翻译成一句能照着做的话。
     */
    const launch = (opts) => pptr.launch(opts).catch((e) => {
      if (/already running for/i.test(String(e.message))) {
        throw new Error(
          '浏览器已经被另一个 PromptCut 实例占着了(它们共用同一份登录态,不能同时开)。'
          + '关掉另一个窗口,或者在那边先调 web_close 再试。',
        );
      }
      throw e;
    });

    const browser = await launch({
      headless: false,
      // 显式给路径,不靠 PUPPETEER_CACHE_DIR 继承。原因:这个变量只有 Tauri 正式包里才设
      // (lib.rs:338),dev 下 puppeteer 会去用开发机自己的 ~/.cache/puppeteer —— 两边
      // 版本碰巧一样时不出事,一旦不一样就是「跑起来的不是随包那份」这种极难查的问题。
      ...(executablePath ? { executablePath } : {}),
      userDataDir,
      args: [
        `--window-position=${OFFSCREEN.left},${OFFSCREEN.top}`,
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        '--no-first-run',
        '--no-default-browser-check',
        // 用户第一眼看到的不该是 Chrome 自己的东西:新 profile 的「登录 Chromium」欢迎页、
        // 上次被强杀后的「要恢复页面吗」气泡,都压掉。不认识的 feature 名 Chrome 会忽略,
        // 多列几个候选不会出错。
        '--hide-crash-restore-bubble',
        '--disable-session-crashed-bubble',
        // agent 打开的页面会自动播视频,用户没在看却在响。Chrome 这条路没法运行时切换,
        // 干脆全程静音;壳模式(WebView2)才有交给用户时放开的开关。
        '--mute-audio',
        '--disable-sync',
        '--disable-features=Translate,MediaRouter,ForYouFre,SigninPromo,ChromeWhatsNewUI',
        // 这里**不加**导出那套 determinism 参数,理由见文件头
      ],
      defaultViewport: null,   // 让页面视口跟随窗口,别让 puppeteer 再套一层
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.setViewport(VIEWPORT);

    const cdp = await page.createCDPSession();
    const { windowId } = await cdp.send('Browser.getWindowForTarget');

    if (userDataDir) writeOwner(userDataDir);
    instance = { browser, page, cdp, windowId, shared: false, userDataDir };
    return instance;
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

/** 现在有没有活着的实例。只看不起:查登录态这类事不该为了「看一眼」拉起一个 Chrome */
export function peekBrowser() {
  if (instance && instance.browser.connected !== false) return instance;
  return null;
}

/**
 * profile 里有没有一个**可能**还活着的浏览器可接管(DevToolsActivePort 在)。
 * 给「只想读一下、不想 launch」的调用方用:有就放心调 getBrowser(它会接管而不是新起),
 * 没有就别调 —— 那会真起一个 Chrome。文件可能是死的,所以只是「可能」。
 */
export function existingEndpoint(dataDir) {
  if (!dataDir) return null;
  return debugEndpoint(path.join(dataDir, 'web-profile'));
}

/** 把窗口挪到屏幕上,交给用户。登录、验证码、cookie 同意都走这条 */
export async function showWindow(inst, { left = 120, top = 80 } = {}) {
  // 壳模式:webview 在主窗口里,摆到哪由前端 invoke 壳的命令决定,这里只解除视口仿真。
  // 必须走 page.setViewport(null):裸调 Emulation.clearDeviceMetricsOverride 只管当下,
  // puppeteer 记着 1280×800,下一次导航又给套回去 —— 实测页面右边和底部就是这么对不上的。
  if (inst.shell) {
    try { await inst.page.setViewport(null); } catch { /* 老版本不认 null,退回裸调 */ }
    try { await inst.cdp.send('Emulation.clearDeviceMetricsOverride'); } catch { /* 忽略 */ }
    return { shell: true };
  }
  /*
   * 实测(2026-09-08,Windows 11):以 -32000,-32000 起的窗口,光用 setWindowBounds 把它挪回
   * 屏幕内是**不够的** —— 位置改对了,但 IsWindowVisible 一直是假,用户屏幕上什么都没有,
   * 而 CDP 那边 bounds 看起来一切正常。先切成 minimized 再还原成 normal,Windows 会把这次
   * 还原当成用户动作:窗口变可见,而且拿到前台。EnumWindows 逐步核对过。
   */
  /*
   * **状态和位置必须分两次发。** CDP 的 setWindowBounds 在同一次调用里同时收到
   * windowState 和 left/top 时,会**只认状态、把位置整个丢掉**。实测(同上,逐步打过 bounds):
   *
   *   minimized 之后           {"left":-32000,...,"windowState":"minimized"}
   *   normal + left:120 一次发  {"left":-32000,...,"windowState":"normal"}   ← 位置没生效
   *   还原之后再单独发 bounds   {"left":120,"top":80,...}                     ← 这才对
   *
   * 所以顺序是:minimized → normal(只给状态)→ 再单独给位置。
   */
  await inst.cdp.send('Browser.setWindowBounds', { windowId: inst.windowId, bounds: { windowState: 'minimized' } });
  await new Promise((r) => setTimeout(r, 150));
  await inst.cdp.send('Browser.setWindowBounds', { windowId: inst.windowId, bounds: { windowState: 'normal' } });
  await new Promise((r) => setTimeout(r, 80));
  await inst.cdp.send('Browser.setWindowBounds', {
    windowId: inst.windowId,
    bounds: { left, top, width: VIEWPORT.width, height: VIEWPORT.height },
  });
  // 还原之后再点一下前台,双保险;抢不到也不影响窗口已经可见
  try { await inst.page.bringToFront(); } catch { /* 忽略 */ }
  // 交给人的时候解除视口仿真:不然用户把窗口拉大,页面还是只画在左上角 1280×800 那一块
  try { await inst.cdp.send('Emulation.clearDeviceMetricsOverride'); } catch { /* 忽略 */ }
}

/** 藏回屏幕外。收回来就把固定视口恢复上:看图算坐标靠它是个常数 */
export async function hideWindow(inst) {
  try { await inst.page.setViewport(VIEWPORT); } catch { /* 忽略 */ }
  if (inst.shell) return { shell: true };
  /*
   * 和 showWindow 同一条坑:状态和位置一次发,位置会被丢掉(实测见上面那段)。
   * 这里以前一直没暴露,是因为窗口通常已经是 normal,同值的状态不算变更、位置能过去。
   * 但用户在接管期间把窗口最大化过的话,这次就是一次真的状态变更 —— 位置被丢掉,
   * 窗口留在屏幕上,而 agent 以为已经藏好了。所以照样拆两步。
   */
  await inst.cdp.send('Browser.setWindowBounds', { windowId: inst.windowId, bounds: { windowState: 'normal' } });
  await inst.cdp.send('Browser.setWindowBounds', {
    windowId: inst.windowId,
    bounds: { ...OFFSCREEN, width: VIEWPORT.width, height: VIEWPORT.height },
  });
}

/** 窗口现在是不是在屏幕上(left >= 0 就算) */
export async function isWindowVisible(inst) {
  const { bounds } = await inst.cdp.send('Browser.getWindowForTarget', { targetId: undefined });
  return bounds.left >= 0;
}
