/**
 * Probe: second screen on the LAN (semantics `docs/semantics/workflow/editing.md` "Second screen on the LAN").
 *
 *   node scripts/probes/mobile-lan-probe.mjs --origin http://127.0.0.1:5396 [--keep]
 *
 * Four things to prove:
 *   M1 A page with mobile identity opened with `?join=<project-id>` receives **mobile app UI**
 *     (local pages also recognize identity, no longer determined solely in online builds);
 *   M2 This page connects to local document service, and content is the project on computer
 *     (add a card on computer, visible on mobile);
 *   M3 No account means no members: **does not render** member entry point on mobile;
 *   M4 Agent tab connects to **local Agent** (not cloud): tab bar is present, chat page is the
 *     local copy.
 *
 * Both pages are opened in the same headless Chrome: one declares desktop (as computer, `?editor`),
 * one declares Android phone (`?join=`).
 * The mobile page does not measure cost or wait for prerender, checking only UI and sync, so it
 * does not need to wait for full-page measurement overlay.
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
    if (Date.now() > until) throw new Error(`Timed out waiting for: ${what} (last seen ${JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  /* ---------------- Computer side ---------------- */
  const pc = await browser.newPage();
  await pc.setUserAgent(DESKTOP_UA);
  await pc.setViewport({ width: 1400, height: 900 });
  await pc.goto(`${ORIGIN}/?editor`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => pc.evaluate(() => !!window.__pcStore), 60_000, 'PC page store');
  // Page with computer identity remains desktop UI as usual
  const pcMobile = await pc.evaluate(() => !!document.querySelector('[data-pc="mobile-ui"]'));
  out.checks.desktopStaysDesktop = !pcMobile;
  if (pcMobile) fails.push('A page declared as desktop got the mobile UI');

  await waitFor(() => pc.evaluate(() => window.__pcSyncTest?.view?.().status === 'online'), 120_000, 'PC page connected to the local document service');
  const projectId = await pc.evaluate(() => window.__pcStore.getState().project.id);
  out.projectId = projectId;
  if (!projectId) fails.push('Cannot read the project ID of the project on the computer');

  /* ---------------- Mobile side ---------------- */
  const phone = await browser.newPage();
  // Must be set together with client hints: `judgeDeviceKind` checks `navigator.userAgentData.mobile` first,
  // if only UA string is changed, this is still false from real browser, classified as computer (`src/online/deviceKind.ts`)
  await phone.setUserAgent(PHONE_UA, { platform: 'Android', platformVersion: '14', mobile: true, architecture: '', model: 'Pixel 8', brands: [{ brand: 'Chromium', version: '152' }] });
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await phone.goto(`${ORIGIN}/?join=${encodeURIComponent(projectId)}`, { waitUntil: 'domcontentloaded' });

  // M1 Mobile app UI
  await waitFor(() => phone.evaluate(() => !!document.querySelector('[data-pc="mobile-ui"]')), 60_000, 'mobile UI mounts');
  out.checks.M1_mobileLayout = true;

  // M2 Connects to local document service, and is the same project
  await waitFor(() => phone.evaluate(() => window.__pcSyncTest?.view?.().status === 'online'), 120_000, 'mobile page connects to the local document service');
  const phoneProjectId = await phone.evaluate(() => window.__pcStore.getState().project.id);
  out.checks.M2_sameProject = phoneProjectId === projectId;
  if (phoneProjectId !== projectId) fails.push(`The project ID on the phone ${phoneProjectId} differs from the one on the computer ${projectId}`);

  // Add a card on computer, should be visible on mobile
  const clipId = await pc.evaluate(() => window.__pcStore.actions.addCardClip('av-pulse', 0, { duration: 1 })?.id ?? null);
  if (!clipId) fails.push('Adding a card on the PC failed');
  else {
    const seen = await waitFor(
      () => phone.evaluate((id) => window.__pcStore.getState().project.tracks.some((t) => t.clips.some((c) => c.id === id)), clipId),
      60_000,
      'The phone sees the card added on the PC',
    ).then(() => true).catch((e) => { fails.push(e.message); return false; });
    out.checks.M2_syncSeen = seen;
    out.clipId = clipId;
  }

  // M3 No account means no member entry point
  out.checks.M3_noMembersButton = await phone.evaluate(() => !document.querySelector('[data-pcm="members-btn"]'));
  if (!out.checks.M3_noMembersButton) fails.push('The phone rendered a members entry (this project has no accounts)');

  // M4 Agent tab writes only one line
  const agentTab = await phone.$('[data-pcm="nav-agent"], [data-pcm="tab-agent"]');
  if (agentTab) await agentTab.click();
  else {
    // If navigation bar tag name has changed, fall back to finding directly by text
    const byText = await phone.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Agent') ?? null);
    const el = byText.asElement();
    if (el) await el.click();
    else fails.push('Cannot find the entry to the Agent tab');
  }
  // The tab itself indicates which instance it uses
  const mode = await waitFor(
    () => phone.evaluate(() => document.querySelector('[data-pcm="agent-page"]')?.getAttribute('data-pcm-agent') ?? ''),
    20_000,
    'Agent tab mounts',
  ).catch((e) => { fails.push(e.message); return ''; });
  out.checks.M4_localAgent = mode === 'local';
  out.agentMode = mode;
  if (mode !== 'local') fails.push(`The Agent tab is not using the local one (data-pcm-agent=${JSON.stringify(mode)})`);

  // What is actually mounted is that local container: it marks local in `__pcMobileAgent` (the cloud copy lacks this mark)
  const containers = await phone.evaluate(() => {
    const m = window.__pcMobileAgent ?? {};
    return Object.entries(m).map(([id, v]) => ({ id, local: v?.local === true }));
  }).catch(() => []);
  out.agentContainers = containers;
  out.checks.M4_localContainer = containers.length > 0 && containers.every((c) => c.local);
  if (!out.checks.M4_localContainer) fails.push(`The mounted chat page is not the local one: ${JSON.stringify(containers)}`);

  // Input area is present (typing still works in local mode), and the old notice is gone
  out.checks.M4_hasComposer = await phone.evaluate(() => !!document.querySelector('.agent-page textarea'));
  if (!out.checks.M4_hasComposer) fails.push('No input box on the Agent tab');
  out.checks.M4_noOldNotice = await phone.evaluate(() => !document.querySelector('[data-pcm="agent-local-notice"]'));
  if (!out.checks.M4_noOldNotice) fails.push('The Agent tab still has the old notice "Please use the AI panel on a computer"');

  out.ok = fails.length === 0;
} catch (e) {
  fails.push(e instanceof Error ? e.message : String(e));
} finally {
  if (!KEEP) await browser.close();
}

console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
