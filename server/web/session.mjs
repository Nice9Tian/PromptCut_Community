/**
 * 动作层:导航 / 点击 / 输入 / 滚动 / 读正文 / 交给用户。
 *
 * ## 每个动作都回一张新的 view
 *
 * 不这么做的话模型得自己记得「点完要再看一眼」,而它经常不记得,然后拿着三轮前的
 * 编号继续点。动作和结果绑在一起返回,编号永远是最新的,这个错就从根上没了。
 * 代价是每个动作多一次截图(约 640 token),值得。
 *
 * ## 为什么串行
 *
 * 整个模块共用一个浏览器一个页,并发点击本来就没有意义(第二次点的时候页面已经被
 * 第一次改了)。更实际的原因是 server/vite-plugin-vision.ts 那条注释记的教训:这台
 * 机器上并发的浏览器实例一多,渲染进程会以 0xC0000142 退出且报不出原因。浏览这个
 * 实例是长驻的,再让它内部并发就是自找麻烦。
 *
 * ## 撞墙就交给人
 *
 * 登录、验证码、cookie 同意 —— 这些**不该也不能由 agent 代劳**(验证码尤其)。
 * detectWall 在每次动作后扫一眼,发现了就在返回里明说,并给出 user_interface_web_handoff 这条路。
 * 不自动弹窗:什么时候打断用户是模型该判断的事,而且自动弹会把离屏浏览器的存在暴露成
 * 一个乱跳的窗口。
 */
import { captureView } from './view.mjs';
import { resolveAt, explain } from './hit.mjs';
import { showWindow, hideWindow } from './browser.mjs';

/** 单个动作的墙钟上限。导航慢站(B 站首屏)十几秒是常事,给足 */
const ACTION_TIMEOUT = 45000;

/** 串行队列。前一个失败也要继续排下一个,所以先 catch 再接 */
let queue = Promise.resolve();
export function enqueue(job) {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

/** 给 page.evaluate 之类没有自带超时的调用套一层 */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} 超过 ${ms / 1000} 秒没返回`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/* c8 ignore start — 页面内执行 */
function scanWall() {
  const has = (sel) => !!document.querySelector(sel);
  const text = (document.body && document.body.innerText || '').slice(0, 4000);
  const walls = [];
  if (has('input[type=password]')) walls.push('login');
  // 站点用的验证码框架:reCAPTCHA / hCaptcha / Cloudflare Turnstile / 极验
  if (has('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"],.geetest_panel,#captcha,[class*=captcha]')) walls.push('captcha');
  if (/扫码登录|扫描二维码|scan (the )?qr/i.test(text)) walls.push('qrcode');
  if (/(cookie|隐私).{0,12}(政策|设置|同意)|accept (all )?cookies|consent/i.test(text)
      && has('button,[role=button]')) walls.push('consent');
  return walls;
}

function readMain(limit) {
  const pick = document.querySelector('article,main,[role=main]') || document.body;
  const t = (pick.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: t.slice(0, limit), total: t.length, url: location.href, title: document.title.slice(0, 120) };
}
/* c8 ignore stop */

/** 每个动作收尾都走这里:扫墙 + 出新 view */
async function finish(page, extra = {}) {
  const walls = await withTimeout(page.evaluate(scanWall), 10000, '检测页面状态');
  const view = await withTimeout(captureView(page), ACTION_TIMEOUT, '截图');
  const out = { ok: true, ...extra, ...view };
  if (walls.length) {
    const names = { login: '登录表单', captcha: '验证码', qrcode: '扫码登录', consent: 'cookie 同意条' };
    out.wall = walls;
    out.wallNote = `这一页有${walls.map((w) => names[w] || w).join('、')}。`
      + '这类事不要自己动手 —— 调 user_interface_web_handoff 把浏览器窗口挪到用户面前,让用户处理完再继续。'
      + (walls.includes('captcha') ? '验证码必须由用户来点。' : '');
  }
  return out;
}

/** 打开一条链接 */
export async function open(page, url, { waitUntil = 'domcontentloaded' } = {}) {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  await page.goto(target, { waitUntil, timeout: ACTION_TIMEOUT });
  return finish(page, { navigated: target });
}

/** 只截屏出清单,不做任何动作。等页面自己加载完、或者滚动之后重看 */
export async function view(page) {
  return finish(page);
}

/**
 * 点击。`u` 直接指定,或者 `x,y` 看图报坐标(强烈建议同时给 expect)。
 *
 * 真正的点击走 puppeteer 的 Locator:它会等元素可见可点、必要时滚进视口,
 * 这些是坐标点击(Input.dispatchMouseEvent)一概不管的。
 */
export async function click(page, { u, x, y, expect } = {}) {
  let uid = u;
  if (!uid) {
    if (typeof x !== 'number' || typeof y !== 'number') {
      return { ok: false, error: '要么给 u,要么给 x,y。x,y 是上一次 web_view 返回的那张图上的像素坐标。' };
    }
    const res = await withTimeout(resolveAt(page, x, y, { expect }), 10000, '命中检测');
    if (!res.ok) return { ok: false, error: explain(res), ...(res.cands ? { candidates: res.cands } : {}) };
    uid = res.pick.u;
  }
  const handle = await page.$(`[data-pcuid="${uid}"]`);
  if (!handle) {
    return { ok: false, error: `找不到 ${uid}。编号只对最近一次 web_view 有效,页面滚动或跳转后就失效了 —— 先重新 web_view。` };
  }
  const label = await page.evaluate(
    (el) => (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40),
    handle,
  );
  // 点击可能触发跳转。跳转期间旧的 handle 会失效,所以等导航和点击一起 race:
  // 有跳转就等它落地,没跳转(单页应用改 DOM)就给一点时间让它渲染完
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
  await handle.click();
  await nav;
  await new Promise((r) => setTimeout(r, 400));
  return finish(page, { clicked: { u: uid, n: label } });
}

/** 往输入框里打字。默认先清空 —— 追加往往不是模型想要的,要追加就传 append */
export async function type(page, { u, text, append = false, submit = false } = {}) {
  const handle = await page.$(`[data-pcuid="${u}"]`);
  if (!handle) return { ok: false, error: `找不到 ${u},先重新 web_view。` };
  await handle.click();
  if (!append) {
    await handle.evaluate((el) => { if ('value' in el) el.value = ''; else el.textContent = ''; });
  }
  await handle.type(String(text ?? ''), { delay: 12 });
  if (submit) {
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
    await page.keyboard.press('Enter');
    await nav;
    await new Promise((r) => setTimeout(r, 400));
  }
  return finish(page, { typed: { u, submit } });
}

/** 滚动。dy 是页面像素(正数往下);也可以 to:"top"/"bottom" */
export async function scroll(page, { dy = 600, to } = {}) {
  await page.evaluate((dy, to) => {
    if (to === 'top') scrollTo({ top: 0 });
    else if (to === 'bottom') scrollTo({ top: document.body.scrollHeight });
    else scrollBy({ top: dy });
  }, dy, to);
  // 懒加载的站点滚完要一会儿才把内容填上
  await new Promise((r) => setTimeout(r, 500));
  return finish(page, { scrolled: to || dy });
}

/**
 * 读正文。**这条不返图**,给「查资料」用 —— 那种场景要的是字,不是画面,
 * 一张图 640 token 换不来比纯文本更多的信息。
 */
export async function read(page, { limit = 8000 } = {}) {
  const r = await withTimeout(page.evaluate(readMain, limit), 15000, '读正文');
  return {
    ok: true, ...r,
    ...(r.total > r.text.length ? { truncated: true, note: `正文共 ${r.total} 字,只给了前 ${r.text.length} 字。要后面的就先 web_scroll 再读。` } : {}),
  };
}

/**
 * 把浏览器窗口挪到用户面前。登录、验证码、扫码、付费墙都走这条。
 *
 * **不等待、不阻塞**:agent 不该坐在这里等人,它应该把这一轮结束、告诉用户要做什么。
 * 用户处理完之后再让 agent 调 web_view 看现在是什么状态。
 */
export async function handoff(inst, { reason = '', hide = false } = {}) {
  // shell: agent 的浏览器是桌面壳里的子 webview,真正的显示 / 隐藏由前端 invoke 壳的命令完成,
  // 这里只把标记带回去。Chrome 方案下这里就是最终动作。
  const shell = !!inst.shell;
  if (hide) {
    await hideWindow(inst);
    return { ok: true, visible: false, shell, message: shell ? '浏览器已经收回。' : '浏览器窗口已经藏回屏幕外。' };
  }
  await showWindow(inst);
  return {
    ok: true,
    visible: true,
    shell,
    message: (shell
      ? `浏览器已经显示在编辑台主窗口里${reason ? `(${reason})` : ''}。`
      : `浏览器窗口已经挪到用户屏幕上${reason ? `(${reason})` : ''}。`)
      + '现在停下来,用中文告诉用户要做什么、做完了怎么说。**不要继续调工具**,'
      + '等用户回话之后再 web_view 看当前状态。',
  };
}
