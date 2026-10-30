/**
 * 探针：局域网里的第二块屏（语义 `docs/semantics/workflow/editing.md`「局域网里的第二块屏」）。
 *
 *   node scripts/probes/mobile-lan-probe.mjs --origin http://127.0.0.1:5396 [--keep]
 *
 * 要证的四件事：
 *   M1 手机身份的页面带 `?join=<项目号>` 打开,拿到的是**手机版界面**(本机页面也认身份,不再只在在线构建里判);
 *   M2 这张页面接上了本机文档服务,而且内容就是电脑上那个项目(电脑上加一张卡,手机上看得见);
 *   M3 没有账号就没有成员:手机上**不画**成员入口;
 *   M4 Agent 分页接的是**本机 Agent**(不是云端):标签栏在、对话页是本机那一份。
 *
 * 两张页面都在同一个无头 Chrome 里开:一张报桌面声明(当电脑,`?editor`),一张报安卓手机声明(`?join=`)。
 * 手机那张不量成本、不等预渲染,只看界面和同步,所以不用等整页的测量遮罩。
 */
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const ORIGIN = (opt('--origin') ?? 'http://127.0.0.1:5190').replace(/\/$/, '');
const KEEP = args.includes('--keep');

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const fails = [];
const out = { ok: false, origin: ORIGIN, checks: {}, fails };

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  let last = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > until) throw new Error(`等不到:${what}(最后一次 ${JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  /* ---------------- 电脑那一侧 ---------------- */
  const pc = await browser.newPage();
  await pc.setUserAgent(DESKTOP_UA);
  await pc.setViewport({ width: 1400, height: 900 });
  await pc.goto(`${ORIGIN}/?editor`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => pc.evaluate(() => !!window.__pcStore), 60_000, '电脑页面的 store');
  // 身份为电脑的页面照旧是桌面界面
  const pcMobile = await pc.evaluate(() => !!document.querySelector('[data-pc="mobile-ui"]'));
  out.checks.desktopStaysDesktop = !pcMobile;
  if (pcMobile) fails.push('电脑声明的页面拿到了手机版界面');

  await waitFor(() => pc.evaluate(() => window.__pcSyncTest?.view?.().status === 'online'), 120_000, '电脑页面接上本机文档服务');
  const projectId = await pc.evaluate(() => window.__pcStore.getState().project.id);
  out.projectId = projectId;
  if (!projectId) fails.push('读不到电脑上那个项目的项目号');

  /* ---------------- 手机那一侧 ---------------- */
  const phone = await browser.newPage();
  // 必须连 client hints 一起设:`judgeDeviceKind` 先看 `navigator.userAgentData.mobile`,
  // 只改 UA 字符串的话这一项还是真浏览器报的 false,身份判成电脑(`src/online/deviceKind.ts`)
  await phone.setUserAgent(PHONE_UA, { platform: 'Android', platformVersion: '14', mobile: true, architecture: '', model: 'Pixel 8', brands: [{ brand: 'Chromium', version: '152' }] });
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await phone.goto(`${ORIGIN}/?join=${encodeURIComponent(projectId)}`, { waitUntil: 'domcontentloaded' });

  // M1 手机版界面
  await waitFor(() => phone.evaluate(() => !!document.querySelector('[data-pc="mobile-ui"]')), 60_000, '手机版界面挂上来');
  out.checks.M1_mobileLayout = true;

  // M2 接上本机文档服务,而且是同一个项目
  await waitFor(() => phone.evaluate(() => window.__pcSyncTest?.view?.().status === 'online'), 120_000, '手机页面接上本机文档服务');
  const phoneProjectId = await phone.evaluate(() => window.__pcStore.getState().project.id);
  out.checks.M2_sameProject = phoneProjectId === projectId;
  if (phoneProjectId !== projectId) fails.push(`手机上的项目号 ${phoneProjectId} 和电脑上的 ${projectId} 不一样`);

  // 电脑上加一张卡,手机上应当看得见
  const clipId = await pc.evaluate(() => window.__pcStore.actions.addCardClip('av-pulse', 0, { duration: 1 })?.id ?? null);
  if (!clipId) fails.push('电脑上加卡失败');
  else {
    const seen = await waitFor(
      () => phone.evaluate((id) => window.__pcStore.getState().project.tracks.some((t) => t.clips.some((c) => c.id === id)), clipId),
      60_000,
      '手机上看见电脑加的那张卡',
    ).then(() => true).catch((e) => { fails.push(e.message); return false; });
    out.checks.M2_syncSeen = seen;
    out.clipId = clipId;
  }

  // M3 没有账号就没有成员入口
  out.checks.M3_noMembersButton = await phone.evaluate(() => !document.querySelector('[data-pcm="members-btn"]'));
  if (!out.checks.M3_noMembersButton) fails.push('手机上画出了成员入口(这个项目没有账号)');

  // M4 Agent 分页只写一句
  const agentTab = await phone.$('[data-pcm="nav-agent"], [data-pcm="tab-agent"]');
  if (agentTab) await agentTab.click();
  else {
    // 导航栏的标记名换过的话,退一步直接按文字找
    const byText = await phone.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Agent') ?? null);
    const el = byText.asElement();
    if (el) await el.click();
    else fails.push('找不到 Agent 分页的入口');
  }
  // 分页本身标着走的是哪一份
  const mode = await waitFor(
    () => phone.evaluate(() => document.querySelector('[data-pcm="agent-page"]')?.getAttribute('data-pcm-agent') ?? ''),
    20_000,
    'Agent 分页挂上来',
  ).catch((e) => { fails.push(e.message); return ''; });
  out.checks.M4_localAgent = mode === 'local';
  out.agentMode = mode;
  if (mode !== 'local') fails.push(`Agent 分页走的不是本机那一份(data-pcm-agent=${JSON.stringify(mode)})`);

  // 真正挂上来的是本机那个容器:它在 `__pcMobileAgent` 里标 local(云端那一份没有这个标)
  const containers = await phone.evaluate(() => {
    const m = window.__pcMobileAgent ?? {};
    return Object.entries(m).map(([id, v]) => ({ id, local: v?.local === true }));
  }).catch(() => []);
  out.agentContainers = containers;
  out.checks.M4_localContainer = containers.length > 0 && containers.every((c) => c.local);
  if (!out.checks.M4_localContainer) fails.push(`挂上来的对话页不是本机那一份:${JSON.stringify(containers)}`);

  // 输入区在(本机模式下照样能打字),而且旧的那句通知不在了
  out.checks.M4_hasComposer = await phone.evaluate(() => !!document.querySelector('.agent-page textarea'));
  if (!out.checks.M4_hasComposer) fails.push('Agent 分页上没有输入框');
  out.checks.M4_noOldNotice = await phone.evaluate(() => !document.querySelector('[data-pcm="agent-local-notice"]'));
  if (!out.checks.M4_noOldNotice) fails.push('Agent 分页上还留着「AI 栏请在电脑上使用」那句旧通知');

  out.ok = fails.length === 0;
} catch (e) {
  fails.push(e instanceof Error ? e.message : String(e));
} finally {
  if (!KEEP) await browser.close();
}

console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
