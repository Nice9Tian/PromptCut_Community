/**
 * 探针：局域网共享项目 + 手机扫码加入（语义 `docs/semantics/workflow/editing.md`「局域网里的第二块屏」）。
 *
 *   node scripts/probes/lan-share-mobile-probe.mjs --origin http://127.0.0.1:5450 [--keep]
 *
 * 编辑器要以局域网模式起（`npm run dev:lan`，即 `PROMPTCUT_LAN_HOST=1`），否则主机不绑局域网、
 * 邀请链接给出去也连不上，探针会在第 2 步报出来。
 *
 * 一路验到底，全程走界面，不绕过任何一步：
 *   S1 电脑那一侧从**项目设置**里开启「多用户协作 + 放本机」（`collab-toggle` → 确定）；
 *   S2 顶栏「⋯」→「在手机上打开」给出**邀请链接与二维码**，链接的源是本机的局域网地址、页面路径是根
 *      （局域网主机没有 `/editor`），并且带着 `doc=/docservice`；
 *   S3 用**手机身份**（安卓声明 + client hints）打开这条链接，落到的是手机版的「加入项目」那一屏，
 *      上面显示的是这个项目的名字；
 *   S4 填个名字点「加入」，进到手机版编辑界面，连上的是同一个项目；
 *   S5 电脑上加一张卡，手机上看得见 —— 两边真同步。
 *
 * 两张页面在同一个无头 Chrome 里：电脑那张走回环（主机自己就在本机，`/api/**` 只答回环），
 * 手机那张走局域网地址（服务端看到的来源就是局域网，和真手机同一条路）。
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
const PHONE_HINTS = { platform: 'Android', platformVersion: '14', mobile: true, architecture: '', model: 'Pixel 8', brands: [{ brand: 'Chromium', version: '152' }] };
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const fails = [];
const out = { ok: false, origin: ORIGIN, steps: {}, fails };

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
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 按文字点一个按钮（设置窗口的「确定」没有 data-pc 钩子） */
async function clickByText(page, selector, text) {
  const handle = await page.evaluateHandle((sel, t) => [...document.querySelectorAll(sel)].find((b) => b.textContent?.trim() === t) ?? null, selector, text);
  const el = handle.asElement();
  if (!el) throw new Error(`找不到文字是「${text}」的 ${selector}`);
  await el.click();
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  /* ---------------- S1 电脑那一侧：开启「多用户协作 + 放本机」 ---------------- */
  const pc = await browser.newPage();
  await pc.setUserAgent(DESKTOP_UA);
  await pc.setViewport({ width: 1440, height: 940 });
  await pc.goto(`${ORIGIN}/?editor`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => pc.evaluate(() => !!window.__pcStore), 60_000, '电脑页面的 store');
  await waitFor(() => pc.evaluate(() => window.__pcSyncTest?.view?.().status === 'online'), 120_000, '电脑页面接上本机文档服务');

  // 编辑器绑没绑局域网:没绑的话后面这条链接给出去手机也连不上,早报早好
  const lan = await pc.evaluate(async () => (await fetch('/api/lan-open').then((r) => r.json())));
  out.steps.lanHost = { lanHost: lan.lanHost, addresses: lan.addresses };
  if (!lan.lanHost) {
    fails.push(`编辑器没绑在局域网上(${lan.command} 起它),这条路跑不了`);
    throw new Error('编辑器只绑了回环');
  }

  await pc.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
  await waitFor(() => pc.evaluate(() => !!document.querySelector('[data-pc="collab-section"]')), 20_000, '项目设置里的协作一节');
  /*
   * 先把项目名改成这一轮专用的:项目名在一台主机上是唯一的,叫「未命名」的话跑第二遍就撞上
   * 「这个项目名已被占用」(`CollabSection` 的 name-taken)。顺带也让局域网发现找得到这一个。
   */
  const projectName = `lan-probe-${Math.random().toString(36).slice(2, 8)}`;
  await pc.click('#pc-proj-name');
  await pc.keyboard.down('Control');
  await pc.keyboard.press('KeyA');
  await pc.keyboard.up('Control');
  await pc.type('#pc-proj-name', projectName);
  out.steps.S1_projectName = projectName;
  await pc.click('[data-pc="collab-toggle"]');
  // 「放在」缺省就是本机,确认一下再点确定;社区版只有局域网一个位置,这一行不画
  const whereLan = await waitFor(
    () => pc.evaluate(() => {
      const lan = document.querySelector('[data-pc="collab-where-lan"]');
      return lan ? lan.className.includes('--on') : !document.querySelector('[data-pc="collab-where-hosted"]');
    }),
    10_000,
    '「放在 · 本机」是选中的',
  ).catch((e) => { fails.push(e.message); return false; });
  out.steps.S1_whereLanDefault = whereLan;
  await clickByText(pc, '.pc-dialog-foot button', '确定');

  const shared = await waitFor(
    () => pc.evaluate(() => {
      const s = window.__pcSyncTest?.view?.().shared;
      return s && s.where === 'lan' ? { projectId: s.projectId, name: s.name, mode: s.mode, creator: !!s.creator } : null;
    }),
    180_000,
    '项目变成「放本机」的共享项目',
  ).catch(async (e) => {
    // 开启没成时协作那一节会写一句话（名字被占、端口被占…），带出来
    out.steps.S1_status = await pc.evaluate(() => document.querySelector('[data-pc="collab-section"]')?.innerText?.slice(0, 300) ?? '(看不到协作一节)').catch(() => null);
    throw e;
  });
  out.steps.S1_shared = shared;

  /*
   * 等协作那一节把邀请链接画出来。**开启这一步没做完就不能往下走**:`enableCollab` 是先建项目、进去,
   * 最后才签邀请码,所以 `shared` 有了不等于链接有了(第一版探针就是在这儿读早了,读到一句
   * 「这台设备上没有邀请链接」)。这一等同时也验了协作设置里放本机也给二维码这一条。
   */
  const sectionLink = await waitFor(
    () => pc.evaluate(() => document.querySelector('[data-pc="collab-invite-link"]')?.textContent?.trim() || null),
    180_000,
    '协作设置里出现邀请链接',
  ).catch(async (e) => {
    out.steps.S1_sectionText = await pc.evaluate(() => document.querySelector('[data-pc="collab-section"]')?.innerText?.slice(0, 400) ?? null).catch(() => null);
    throw e;
  });
  out.steps.S1_sectionInvite = {
    qr: await pc.evaluate(() => !!document.querySelector('[data-pc="collab-qr"] svg')),
    link: sectionLink,
  };
  if (!out.steps.S1_sectionInvite.qr) fails.push('协作设置里没画出二维码');

  /* ---------------- S2 「在手机上打开」给出邀请链接 ---------------- */
  // 设置窗口做完会留着显示结果，先关掉再开「⋯」菜单
  await pc.keyboard.press('Escape');
  await waitFor(() => pc.evaluate(() => !document.querySelector('[data-pc="collab-section"]')), 20_000, '设置窗口关上');
  await pc.click('button[title="更多设置"]');
  await waitFor(() => pc.evaluate(() => !!document.querySelector('[data-pc="more-lan-open"]')), 10_000, '⋯ 菜单');
  await pc.click('[data-pc="more-lan-open"]');
  const link = await waitFor(
    () => pc.evaluate(() => document.querySelector('[data-pc="lan-open-link"]')?.textContent?.trim() || null),
    30_000,
    '「在手机上打开」给出邀请链接',
  ).catch(async (e) => {
    // 没给链接时把窗口现在的样子带出来,免得只知道「等不到」
    out.steps.S2_dialog = await pc.evaluate(() => ({
      branch: ['lan-open-not-shared', 'lan-open-off', 'lan-open-invite', 'lan-open-no-invite', 'lan-open-error']
        .find((k) => document.querySelector(`[data-pc="${k}"]`)) ?? '(没有)',
      text: document.querySelector('[data-pc="lan-open-dialog"]')?.innerText?.slice(0, 300) ?? '(没有窗口)',
    })).catch(() => null);
    throw e;
  });
  const hasQr = await pc.evaluate(() => !!document.querySelector('[data-pc="lan-open-qr"] svg'));
  const warn = await pc.evaluate(() => document.querySelector('[data-pc="lan-open-link-warn"]')?.textContent?.trim() ?? '');
  out.steps.S2_link = link;
  out.steps.S2_qr = hasQr;
  if (!hasQr) fails.push('没有画出二维码');
  if (warn) fails.push(`窗口说链接地址不在本机网卡上:${warn}`);

  const u = new URL(link);
  const lanAddresses = lan.addresses.map((a) => a.address);
  out.steps.S2_linkChecks = {
    hostOnLan: lanAddresses.includes(u.hostname),
    pageIsRoot: u.pathname === '/',
    // 末尾不能带斜杠:局域网主机的 WebSocket 要的是不带斜杠的 `/docservice`
    hasDoc: /(^|&)doc=%2Fdocservice(&|$)/i.test(u.hash.replace(/^#/, '')),
  };
  if (!out.steps.S2_linkChecks.hostOnLan) fails.push(`链接的主机 ${u.hostname} 不在本机局域网地址里(${lanAddresses.join('、')})`);
  if (!out.steps.S2_linkChecks.pageIsRoot) fails.push(`链接的页面路径是 ${u.pathname},局域网主机上应当是根 /`);
  if (!out.steps.S2_linkChecks.hasDoc) fails.push(`链接里没有 doc=/docservice:${u.hash}`);

  /* ---------------- S3 手机身份打开这条链接 ---------------- */
  const phone = await browser.newPage();
  await phone.setUserAgent(PHONE_UA, PHONE_HINTS);
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phoneErrors = [];
  const phoneBadResponses = [];
  phone.on('console', (m) => { if (m.type() === 'error') phoneErrors.push(m.text().slice(0, 200)); });
  // 哪个接口回了 4xx / 5xx:局域网那一侧最常见的毛病是「这个口只答回环」,记下地址才看得出是哪一个
  phone.on('response', (r) => {
    if (r.status() >= 400) phoneBadResponses.push(`${r.status()} ${r.request().method()} ${r.url().replace(ORIGIN, '').slice(0, 120)}`);
  });
  await phone.goto(link, { waitUntil: 'domcontentloaded' });
  await waitFor(() => phone.evaluate(() => !!document.querySelector('[data-pcm="join-invite"]')), 60_000, '手机版的「加入项目」那一屏')
    .catch(async (e) => {
      // 没落到那一屏时把页面现在的样子带出来:挂的是哪一套界面、有哪些标记、报了什么错
      out.steps.S3_page = await phone.evaluate(() => ({
        mobileUi: !!document.querySelector('[data-pc="mobile-ui"]'),
        markers: [...document.querySelectorAll('[data-pcm],[data-pc]')].slice(0, 12).map((el) => el.getAttribute('data-pcm') || el.getAttribute('data-pc')),
        title: document.title,
        text: (document.body.innerText || '').slice(0, 300),
      })).catch(() => null);
      out.phoneErrors = phoneErrors.slice(0, 8);
      out.phoneBadResponses = phoneBadResponses.slice(0, 12);
      throw e;
    });
  const shownName = await waitFor(
    () => phone.evaluate(() => {
      const t = document.querySelector('[data-pcm="join-project"]')?.textContent?.trim() ?? '';
      return t && !t.includes('正在查') ? t : null;
    }),
    60_000,
    '查出这张码对应哪个项目',
  );
  out.steps.S3_shownName = shownName;
  if (!shownName.includes(shared.name)) fails.push(`加入那一屏显示的是 ${JSON.stringify(shownName)},不是项目名 ${JSON.stringify(shared.name)}`);

  /* ---------------- S4 填名字加入 ---------------- */
  // 点加入之前先看一眼设备身份：局域网来的页面问不到编辑器进程，要退回页面自己那一份
  out.steps.S3_device = await phone.evaluate(() => {
    const v = window.__pcSyncTest?.view?.();
    return { fromView: v?.device ?? null, hasSyncTest: !!window.__pcSyncTest };
  }).catch(() => null);

  await phone.type('[data-pcm="join-username"]', '手机探针');
  await phone.click('[data-pcm="join-submit"]');
  // 离开「加入项目」那一屏才算进去了(`data-pc="mobile-ui"` 在外层,那一屏上本来就有,不能拿它当凭据)
  await waitFor(() => phone.evaluate(() => !document.querySelector('[data-pcm="join-invite"]') && !!document.querySelector('[data-pc="mobile-ui"]')), 120_000, '手机离开加入那一屏、进到手机版编辑界面')
    .catch(async (e) => {
      out.steps.S4_joinScreen = await phone.evaluate(() => ({
        msg: document.querySelector('[data-pcm="join-msg"]')?.textContent?.trim() ?? null,
        dead: document.querySelector('[data-pcm="join-dead"]')?.textContent?.trim() ?? null,
        text: (document.body.innerText || '').slice(0, 240),
      })).catch(() => null);
      out.phoneErrors = phoneErrors.slice(0, 8);
      out.phoneBadResponses = phoneBadResponses.slice(0, 12);
      throw e;
    });
  await waitFor(() => phone.evaluate(() => window.__pcSyncTest?.view?.().status === 'online'), 120_000, '手机那张页面接上文档服务')
    .catch(async (e) => {
      out.steps.S4_sync = await phone.evaluate(() => window.__pcSyncTest?.view?.() ?? null).catch(() => null);
      out.phoneErrors = phoneErrors.slice(0, 8);
      out.phoneBadResponses = phoneBadResponses.slice(0, 12);
      throw e;
    });
  const phoneShared = await phone.evaluate(() => {
    const s = window.__pcSyncTest?.view?.().shared;
    return s ? { projectId: s.projectId, name: s.name, where: s.where } : null;
  });
  out.steps.S4_phoneShared = phoneShared;
  if (phoneShared?.projectId !== shared.projectId) fails.push(`手机连上的项目号 ${phoneShared?.projectId} 和电脑上的 ${shared.projectId} 不一样`);

  /* ---------------- S5 电脑上加一张卡，手机上看得见 ---------------- */
  const clipId = await pc.evaluate(() => window.__pcStore.actions.addCardClip('av-pulse', 0, { duration: 1 })?.id ?? null);
  out.steps.S5_clipId = clipId;
  if (!clipId) fails.push('电脑上加卡失败');
  else {
    const seen = await waitFor(
      () => phone.evaluate((id) => window.__pcStore.getState().project.tracks.some((t) => t.clips.some((c) => c.id === id)), clipId),
      90_000,
      '手机上看见电脑加的那张卡',
    ).then(() => true).catch((e) => { fails.push(e.message); return false; });
    out.steps.S5_syncSeen = seen;
  }

  out.phoneErrors = phoneErrors.slice(0, 6);
  out.phoneBadResponses = phoneBadResponses.slice(0, 12);
  out.ok = fails.length === 0;
} catch (e) {
  fails.push(e instanceof Error ? e.message : String(e));
} finally {
  if (!KEEP) await browser.close();
}

console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
