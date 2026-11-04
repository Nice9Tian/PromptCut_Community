/**
 * Probe: LAN shared project + mobile QR code join (semantics `docs/semantics/workflow/editing.md`
 * "Second Screen on LAN").
 *
 *   node scripts/probes/lan-share-mobile-probe.mjs --origin http://127.0.0.1:5450 [--keep]
 *
 * The editor must be started in LAN mode (`npm run dev:lan`, i.e. `PROMPTCUT_LAN_HOST=1`); otherwise
 * the host does not bind to LAN and the invite link cannot connect even if shared, which the probe
 * reports in step 2.
 *
 * Verifies end-to-end entirely through the UI without bypassing any step:
 *   S1 On the desktop side, enable "multi-user collaboration + local" in **Project settings**
 *      (`collab-toggle` → Confirm);
 *   S2 Top bar "⋯" → "Open on mobile" provides the **invite link and QR code**; the link origin
 *      is the local machine's LAN address, page path is root (LAN host has no `/editor`), and carries
 *      `doc=/docservice`;
 *   S3 Open this link with **mobile identity** (Android user agent + client hints), landing on the
 *      mobile app's "Join project" screen, which displays the name of this project;
 *   S4 Enter a name and click "Join" to enter the mobile app editor, connecting to the same project;
 *   S5 Add a card on desktop, visible on mobile: truly synced on both sides.
 *
 * Both pages run in the same headless Chrome: the desktop page uses loopback (the host itself is on
 * this machine, `/api/**` responds only to loopback), and the mobile page uses the LAN address
 * (server sees the source as LAN, identical path to a real phone).
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
    if (Date.now() > until) throw new Error(`Timed out waiting for: ${what} (last seen ${JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Click a button by text (the settings dialog "Confirm" has no data-pc hook) */
async function clickByText(page, selector, text) {
  const handle = await page.evaluateHandle((sel, t) => [...document.querySelectorAll(sel)].find((b) => b.textContent?.trim() === t) ?? null, selector, text);
  const el = handle.asElement();
  if (!el) throw new Error(`Cannot find ${selector} with text "${text}"`);
  await el.click();
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  /* ---------------- S1 Desktop side: enable "multi-user collaboration + local" ---------------- */
  const pc = await browser.newPage();
  await pc.setUserAgent(DESKTOP_UA);
  await pc.setViewport({ width: 1440, height: 940 });
  await pc.goto(`${ORIGIN}/?editor`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => pc.evaluate(() => !!window.__pcStore), 60_000, 'PC page store');
  await waitFor(() => pc.evaluate(() => window.__pcSyncTest?.view?.().status === 'online'), 120_000, 'PC page connected to the local document service');

  // Whether the editor is bound to LAN: if not, mobile cannot connect to the shared link later; report early
  const lan = await pc.evaluate(async () => (await fetch('/api/lan-open').then((r) => r.json())));
  out.steps.lanHost = { lanHost: lan.lanHost, addresses: lan.addresses };
  if (!lan.lanHost) {
    fails.push(`The editor is not bound to the LAN (start it with ${lan.command}), this route cannot run`);
    throw new Error('The editor is bound to loopback only');
  }

  await pc.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
  await waitFor(() => pc.evaluate(() => !!document.querySelector('[data-pc="collab-section"]')), 20_000, 'collaboration section in project settings');
  /*
   * First change project name to one dedicated to this run: project name is unique on a single host;
   * keeping "Untitled" hits "This project name is already in use" (`CollabSection` name-taken) on the
   * second run. This also allows LAN discovery to find it.
   */
  const projectName = `lan-probe-${Math.random().toString(36).slice(2, 8)}`;
  await pc.click('#pc-proj-name');
  await pc.keyboard.down('Control');
  await pc.keyboard.press('KeyA');
  await pc.keyboard.up('Control');
  await pc.type('#pc-proj-name', projectName);
  out.steps.S1_projectName = projectName;
  await pc.click('[data-pc="collab-toggle"]');
  // "Location" defaults to local; verify before clicking Confirm; community edition only has LAN
  // location, so this row is not rendered
  const whereLan = await waitFor(
    () => pc.evaluate(() => {
      const lan = document.querySelector('[data-pc="collab-where-lan"]');
      return lan ? lan.className.includes('--on') : !document.querySelector('[data-pc="collab-where-hosted"]');
    }),
    10_000,
    '"Stored on · This machine" is selected',
  ).catch((e) => { fails.push(e.message); return false; });
  out.steps.S1_whereLanDefault = whereLan;
  await clickByText(pc, '.pc-dialog-foot button', 'OK');

  const shared = await waitFor(
    () => pc.evaluate(() => {
      const s = window.__pcSyncTest?.view?.().shared;
      return s && s.where === 'lan' ? { projectId: s.projectId, name: s.name, mode: s.mode, creator: !!s.creator } : null;
    }),
    180_000,
    'The project becomes a shared project "stored on this machine"',
  ).catch(async (e) => {
    // When enabling fails, the collaboration section displays a message (name taken, port taken…); extract it
    out.steps.S1_status = await pc.evaluate(() => document.querySelector('[data-pc="collab-section"]')?.innerText?.slice(0, 300) ?? '(collaboration section not visible)').catch(() => null);
    throw e;
  });
  out.steps.S1_shared = shared;

  /*
   * Wait for collaboration section to render the invite link. **Cannot proceed until this enable
   * step finishes**: `enableCollab` creates the project first, enters it, and signs the invite code
   * at the very end, so having `shared` does not mean the link exists (the first probe version read
   * too early here and saw "No invite link on this device"). Waiting here also verifies that
   * collaboration settings provide a QR code when hosting locally.
   */
  const sectionLink = await waitFor(
    () => pc.evaluate(() => document.querySelector('[data-pc="collab-invite-link"]')?.textContent?.trim() || null),
    180_000,
    'Invite link appears in collaboration settings',
  ).catch(async (e) => {
    out.steps.S1_sectionText = await pc.evaluate(() => document.querySelector('[data-pc="collab-section"]')?.innerText?.slice(0, 400) ?? null).catch(() => null);
    throw e;
  });
  out.steps.S1_sectionInvite = {
    qr: await pc.evaluate(() => !!document.querySelector('[data-pc="collab-qr"] svg')),
    link: sectionLink,
  };
  if (!out.steps.S1_sectionInvite.qr) fails.push('QR code not drawn in collaboration settings');

  /* ---------------- S2 "Open on mobile" provides invite link ---------------- */
  // Settings dialog remains open showing results after completion; close it before opening the "⋯" menu
  await pc.keyboard.press('Escape');
  await waitFor(() => pc.evaluate(() => !document.querySelector('[data-pc="collab-section"]')), 20_000, 'settings window closes');
  await pc.click('button[title="More settings"]');
  await waitFor(() => pc.evaluate(() => !!document.querySelector('[data-pc="more-lan-open"]')), 10_000, '⋯ menu');
  await pc.click('[data-pc="more-lan-open"]');
  const link = await waitFor(
    () => pc.evaluate(() => document.querySelector('[data-pc="lan-open-link"]')?.textContent?.trim() || null),
    30_000,
    '"Open on phone" gives an invite link',
  ).catch(async (e) => {
    // If no link is provided, capture current dialog state to avoid knowing only "timed out waiting"
    out.steps.S2_dialog = await pc.evaluate(() => ({
      branch: ['lan-open-not-shared', 'lan-open-off', 'lan-open-invite', 'lan-open-no-invite', 'lan-open-error']
        .find((k) => document.querySelector(`[data-pc="${k}"]`)) ?? '(none)',
      text: document.querySelector('[data-pc="lan-open-dialog"]')?.innerText?.slice(0, 300) ?? '(no dialog)',
    })).catch(() => null);
    throw e;
  });
  const hasQr = await pc.evaluate(() => !!document.querySelector('[data-pc="lan-open-qr"] svg'));
  const warn = await pc.evaluate(() => document.querySelector('[data-pc="lan-open-link-warn"]')?.textContent?.trim() ?? '');
  out.steps.S2_link = link;
  out.steps.S2_qr = hasQr;
  if (!hasQr) fails.push('QR code not drawn');
  if (warn) fails.push(`The dialog says the link address is not on a local network adapter: ${warn}`);

  const u = new URL(link);
  const lanAddresses = lan.addresses.map((a) => a.address);
  out.steps.S2_linkChecks = {
    hostOnLan: lanAddresses.includes(u.hostname),
    pageIsRoot: u.pathname === '/',
    // Trailing slash not allowed: LAN host WebSocket expects `/docservice` without a slash
    hasDoc: /(^|&)doc=%2Fdocservice(&|$)/i.test(u.hash.replace(/^#/, '')),
  };
  if (!out.steps.S2_linkChecks.hostOnLan) fails.push(`Link host ${u.hostname} is not among the local LAN addresses (${lanAddresses.join(', ')})`);
  if (!out.steps.S2_linkChecks.pageIsRoot) fails.push(`The link's page path is ${u.pathname}, but on a LAN host it should be the root /`);
  if (!out.steps.S2_linkChecks.hasDoc) fails.push(`No doc=/docservice in the link: ${u.hash}`);

  /* ---------------- S3 Open this link with mobile identity ---------------- */
  const phone = await browser.newPage();
  await phone.setUserAgent(PHONE_UA, PHONE_HINTS);
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phoneErrors = [];
  const phoneBadResponses = [];
  phone.on('console', (m) => { if (m.type() === 'error') phoneErrors.push(m.text().slice(0, 200)); });
  // Which endpoint returned 4xx / 5xx: most common issue on LAN side is "this port only responds to
  // loopback"; recording address reveals which one
  phone.on('response', (r) => {
    if (r.status() >= 400) phoneBadResponses.push(`${r.status()} ${r.request().method()} ${r.url().replace(ORIGIN, '').slice(0, 120)}`);
  });
  await phone.goto(link, { waitUntil: 'domcontentloaded' });
  await waitFor(() => phone.evaluate(() => !!document.querySelector('[data-pcm="join-invite"]')), 60_000, 'the mobile app\'s "Join project" screen')
    .catch(async (e) => {
      // If it did not land on that screen, capture current page state: which UI is mounted, what markers
      // exist, what errors occurred
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
      return t && !t.includes('Checking') ? t : null;
    }),
    60_000,
    'Looks up which project the code belongs to',
  );
  out.steps.S3_shownName = shownName;
  if (!shownName.includes(shared.name)) fails.push(`The join screen shows ${JSON.stringify(shownName)}, not the project name ${JSON.stringify(shared.name)}`);

  /* ---------------- S4 Enter name and join ---------------- */
  // Inspect device identity before clicking join: pages coming from LAN cannot query editor process
  // and must fall back to page's own copy
  out.steps.S3_device = await phone.evaluate(() => {
    const v = window.__pcSyncTest?.view?.();
    return { fromView: v?.device ?? null, hasSyncTest: !!window.__pcSyncTest };
  }).catch(() => null);

  await phone.type('[data-pcm="join-username"]', 'Phone probe');
  await phone.click('[data-pcm="join-submit"]');
  // Only leaving the "Join project" screen counts as joined (`data-pc="mobile-ui"` is on outer
  // wrapper, already present on that screen, cannot be used as proof)
  await waitFor(() => phone.evaluate(() => !document.querySelector('[data-pcm="join-invite"]') && !!document.querySelector('[data-pc="mobile-ui"]')), 120_000, 'The phone leaves the join screen and enters the mobile app editor')
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
  await waitFor(() => phone.evaluate(() => window.__pcSyncTest?.view?.().status === 'online'), 120_000, 'phone page connected to the document service')
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
  if (phoneShared?.projectId !== shared.projectId) fails.push(`The project id the phone connected to (${phoneShared?.projectId}) differs from the PC's (${shared.projectId})`);

  /* ---------------- S5 Add a card on desktop, visible on mobile ---------------- */
  const clipId = await pc.evaluate(() => window.__pcStore.actions.addCardClip('av-pulse', 0, { duration: 1 })?.id ?? null);
  out.steps.S5_clipId = clipId;
  if (!clipId) fails.push('Adding a card on the PC failed');
  else {
    const seen = await waitFor(
      () => phone.evaluate((id) => window.__pcStore.getState().project.tracks.some((t) => t.clips.some((c) => c.id === id)), clipId),
      90_000,
      'The phone sees the card added on the PC',
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
