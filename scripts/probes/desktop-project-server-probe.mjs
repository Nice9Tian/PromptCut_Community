// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * End-to-end acceptance probe for Desktop New Project Modal, Personal Project Conversions,
 * Render Server Data Panel, Team Project LAN/WAN Discovery, and Creator-Gated Data Server
 * Handover with Mutual 6-Digit Pairing Code Verification (Issues #7 & #8).
 *
 *   node scripts/probes/desktop-project-server-probe.mjs [--shots <dir>] [--port-a 5270] [--port-b 5273]
 *
 * Exercises two isolated desktop Vite instances (Host A and Host B) in real Chromium across
 * Simplified Chinese (`zh-CN`) and English (`en`):
 *   P1 Desktop New Project Modal on StartPage (`zh-CN` & `en`): Local / Cloud / More choices.
 *   P2 More -> Render Server Data Panel: live node status, throughput metrics, task records,
 *      "Add joined project" and "Add invite link" tabs.
 *   P3 More -> Team Project: member account management (`rw`/`r`) and LAN / WAN discovery.
 *   P4 Personal Project Management Conversions: "Switch to online project" and
 *      "Convert to team project" on both Classic StartPage draft cards and Vibe DesktopStart row menu.
 *   P5 Convert personal draft to LAN Team Project + Project Settings -> "Become render server"
 *      workspace dashboard + return to editor + Invite-link binding in Host B Render Server pool.
 *   P6 Issue #8 Creator Visibility Gate: non-creator team member (`alice`) sees "Become render server"
 *      in Project Settings, while "Become data server" is strictly absent (`null`).
 *   P7 Issue #8 Multi-Machine Data Server Handover:
 *      - Creator joins on Host B and clicks "Become data server (member accounts & project document)".
 *      - Original creator machine (Host A) pops up Approval Dialog ("Approve data server handover?") -> Agree.
 *      - Mutual 6-digit pairing code verification (wrong code rejected, matching code accepted + Host A confirms).
 *      - Host B transitions into Data Server Panel (member accounts + modification history) and clicks
 *        "Join own project in editor" to edit its own hosted project directly, recording new commits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startDevServer, tripleFree } from '../lib/dev-server.mjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

setTimeout(() => {
  console.error('SCRIPT_TIMEOUT');
  process.exit(124);
}, 15 * 60_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const SHOTS = path.resolve(arg('--shots', path.join(os.tmpdir(), 'desktop-project-server-shots')));
fs.mkdirSync(SHOTS, { recursive: true });

const fails = [];
const shotFiles = [];
const check = (cond, label, extra) => {
  if (!cond) {
    fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400)));
  }
  return Boolean(cond);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sel = (pc) => `[data-pc="${pc}"]`;

async function setInputValue(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 25_000 });
  await page.$eval(selector, (el, val) => {
    el.focus();
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function inspectTextClipping(page) {
  return page.evaluate(() => {
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.01;
    };
    const cut = [];
    for (const el of document.querySelectorAll('button, [role="tab"], [role="menuitem"]')) {
      if (!visible(el) || !el.textContent.trim()) continue;
      const s = getComputedStyle(el);
      if (s.overflowX !== 'visible' && s.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) {
        cut.push(el.textContent.trim().slice(0, 60));
      }
    }
    for (const span of document.querySelectorAll('button:not(.pc-btn--collapsed) .pc-btn-label')) {
      if (!visible(span) || !span.textContent.trim()) continue;
      if (span.scrollWidth > span.clientWidth + 2) {
        cut.push(span.textContent.trim().slice(0, 60));
      }
    }
    return [...new Set(cut)];
  });
}

async function openProjectSettings(page) {
  await page.waitForSelector('button.pc-proj-btn', { visible: true, timeout: 30_000 });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await page.click('button.pc-proj-btn').catch(() => {});
    const opened = await page
      .waitForSelector('.pc-proj-menu [role="menuitem"]', { visible: true, timeout: 1500 })
      .catch(() => null);
    if (opened) break;
    await sleep(400);
  }
  const items = await page.$$('.pc-proj-menu [role="menuitem"]');
  if (items.length === 0) throw new Error('Project menu has no items');
  await items[items.length - 1].click();
  await page.waitForSelector(sel('settings-server-roles'), { visible: true, timeout: 15_000 });
}

async function saveProjectInEditor(page) {
  await page.waitForSelector('button.pc-proj-btn', { visible: true, timeout: 30_000 });
  await page.click('button.pc-proj-btn');
  await page.waitForSelector('.pc-proj-menu [role="menuitem"]', { visible: true, timeout: 15_000 });
  const items = await page.$$('.pc-proj-menu [role="menuitem"]');
  if (items.length < 3) throw new Error('Save item missing in Project menu');
  await items[2].click();
  await sleep(600);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-issues-7-8-'));
const boxA = path.join(tempRoot, 'host-a');
const boxB = path.join(tempRoot, 'host-b');
fs.mkdirSync(boxA, { recursive: true });
fs.mkdirSync(boxB, { recursive: true });
const mockAiConfig = JSON.stringify({ api: { vendor: 'mock', model: 'mock', source: 'custom' } });
fs.writeFileSync(path.join(boxA, 'ai.json'), mockAiConfig);
fs.writeFileSync(path.join(boxB, 'ai.json'), mockAiConfig);

let serverA = null;
let serverB = null;
let browser = null;
const pageErrors = [];
const consoleErrors = [];
const activePages = [];

try {
  const reqPortA = Number(arg('--port-a', '5270')) || 5270;
  const reqPortB = Number(arg('--port-b', '5273')) || 5273;
  const portA = (await tripleFree(reqPortA)) ? reqPortA : undefined;
  serverA = await startDevServer({
    port: portA,
    env: {
      PROMPTCUT_NO_PORT_FILE: '1',
      PROMPTCUT_DATA_DIR: path.join(boxA, 'data'),
      PROMPTCUT_EXPORT_DIR: path.join(boxA, 'exports'),
      PROMPTCUT_PROJECTS_DIR: path.join(boxA, 'projects'),
      PROMPTCUT_CHATS_DIR: path.join(boxA, 'chats'),
      PROMPTCUT_AI_CONFIG: path.join(boxA, 'ai.json'),
      PROMPTCUT_DEVICE_ID: 'dev-host-alpha-0001',
      PROMPTCUT_DEVICE_NAME: 'Studio-Host-Alpha',
    },
    logFile: path.join(boxA, 'vite.log'),
  });

  const portB = reqPortB !== serverA.port && (await tripleFree(reqPortB)) ? reqPortB : undefined;
  serverB = await startDevServer({
    port: portB,
    env: {
      PROMPTCUT_NO_PORT_FILE: '1',
      PROMPTCUT_DATA_DIR: path.join(boxB, 'data'),
      PROMPTCUT_EXPORT_DIR: path.join(boxB, 'exports'),
      PROMPTCUT_PROJECTS_DIR: path.join(boxB, 'projects'),
      PROMPTCUT_CHATS_DIR: path.join(boxB, 'chats'),
      PROMPTCUT_AI_CONFIG: path.join(boxB, 'ai.json'),
      PROMPTCUT_DEVICE_ID: 'dev-host-beta-0002',
      PROMPTCUT_DEVICE_NAME: 'Studio-Host-Beta',
    },
    logFile: path.join(boxB, 'vite.log'),
  });

  browser = await puppeteer.launch({
    headless: true,
    args: [...PROBE_CHROME_ARGS, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,860'],
  });

  const attachErrorListeners = (p, tag) => {
    activePages.push({ page: p, tag });
    p.on('pageerror', (e) => pageErrors.push(`${tag}: ${String(e).slice(0, 300)}`));
    p.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`${tag}: ${m.text().slice(0, 300)}`);
    });
  };

  const snap = async (page, fileName) => {
    await sleep(350);
    const full = path.join(SHOTS, fileName);
    await page.screenshot({ path: full });
    shotFiles.push(full);
    const cut = await inspectTextClipping(page);
    check(cut.length === 0, `L3 no clipped button/tab text in ${fileName}`, cut);
  };

  /* ======================================================================
   * P1: StartPage New Project Modal (`zh-CN` and `en`)
   * ====================================================================== */
  const ctxHostA = await browser.createBrowserContext();
  const pageA = await ctxHostA.newPage();
  await pageA.setViewport({ width: 1280, height: 860 });
  attachErrorListeners(pageA, 'hostA-zh');

  await pageA.goto(`${serverA.origin}/?lang=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pageA.waitForSelector('.sp-hero', { visible: true, timeout: 45_000 });
  await pageA.click('.sp-hero');
  await pageA.waitForSelector(sel('new-project-dialog'), { visible: true, timeout: 15_000 });

  const zhChoices = await pageA.$$eval(
    '[data-pc="new-project-choice-local"] .npd-choice-title, [data-pc="new-project-choice-cloud"] .npd-choice-title, [data-pc="new-project-choice-more"] .npd-choice-title',
    (els) => els.map((e) => e.textContent.trim()),
  );
  check(
    zhChoices[0] === '\u672c\u5730\u9879\u76ee' && zhChoices[1] === '\u4e91\u7aef\u9879\u76ee' && zhChoices[2] === '\u66f4\u591a',
    'P1a zh-CN modal shows Local / Cloud / More choices',
    zhChoices,
  );
  await snap(pageA, '01-zh-new-project-modal.png');

  // Verify English New Project modal & Cloud tab in separate context
  const ctxEn = await browser.createBrowserContext();
  const pageEn = await ctxEn.newPage();
  await pageEn.setViewport({ width: 1280, height: 860 });
  attachErrorListeners(pageEn, 'hostA-en');
  await pageEn.goto(`${serverA.origin}/?lang=en`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pageEn.waitForSelector('.sp-hero', { visible: true, timeout: 45_000 });
  await pageEn.click('.sp-hero');
  await pageEn.waitForSelector(sel('new-project-dialog'), { visible: true, timeout: 15_000 });

  const enChoices = await pageEn.$$eval(
    '[data-pc="new-project-choice-local"] .npd-choice-title, [data-pc="new-project-choice-cloud"] .npd-choice-title, [data-pc="new-project-choice-more"] .npd-choice-title',
    (els) => els.map((e) => e.textContent.trim()),
  );
  check(
    enChoices[0] === 'Local project' && enChoices[1] === 'Cloud project' && enChoices[2] === 'More',
    'P1b en modal shows Local project / Cloud project / More',
    enChoices,
  );
  await pageEn.click(sel('new-project-choice-cloud'));
  await pageEn.waitForSelector(sel('new-project-cloud-view'), { visible: true, timeout: 10_000 });
  await snap(pageEn, '02-en-new-project-cloud.png');

  /* ======================================================================
   * P2: More -> Render Server Data Panel (`zh-CN` & `en`) + Live Task Record
   * ====================================================================== */
  await pageA.click(sel('new-project-choice-more'));
  await pageA.waitForSelector(sel('new-project-more-grid'), { visible: true, timeout: 10_000 });
  const moreTitlesZh = await pageA.$$eval('.npd-more-item b', (els) => els.map((e) => e.textContent.trim()));
  check(
    moreTitlesZh.includes('\u6e32\u67d3\u670d\u52a1\u5668') && moreTitlesZh.includes('\u56e2\u961f\u9879\u76ee'),
    'P2a More view shows Render server and Team project in zh-CN',
    moreTitlesZh,
  );
  await snap(pageA, '03-zh-new-project-more.png');

  // Record a live prerender task on Host A so throughput & records table populate
  const recRes = await fetch(`${serverA.origin}/api/render-server/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: serverA.origin },
    body: JSON.stringify({
      projectName: 'Intro_Reel_4K',
      kind: 'prerender',
      frames: 180,
      segments: 3,
      durationMs: 1500,
      status: 'completed',
    }),
  }).then((r) => r.json());
  check(Boolean(recRes?.ok), 'P2b /api/render-server/record accepted task', recRes);

  await pageA.click(sel('new-project-more-render-server'));
  await pageA.waitForSelector(`${sel('render-server-panel')}[data-mode="embedded"]`, { visible: true, timeout: 15_000 });
  await pageA.waitForSelector(sel('rs-records-table'), { visible: true, timeout: 15_000 });

  const rsMetrics = await pageA.evaluate(() => ({
    completed: document.querySelector('[data-pc="rs-metric-completed"]')?.textContent?.trim(),
    frames: document.querySelector('[data-pc="rs-metric-frames"]')?.textContent?.trim(),
    joinedTab: document.querySelector('[data-pc="rs-add-joined-tab"]')?.textContent?.trim(),
    inviteTab: document.querySelector('[data-pc="rs-add-invite-tab"]')?.textContent?.trim(),
    rows: document.querySelectorAll('[data-pc="rs-record-row"]').length,
  }));
  check(
    Number(rsMetrics.completed) >= 1 && Number(rsMetrics.frames) >= 180 && rsMetrics.rows >= 1,
    'P2c Render server panel displays live metrics and task record',
    rsMetrics,
  );
  await snap(pageA, '04-zh-render-server-embedded.png');

  // Also capture English Render Server embedded panel
  await pageEn.click(sel('new-project-choice-more'));
  await pageEn.waitForSelector(sel('new-project-more-render-server'), { visible: true, timeout: 10_000 });
  await pageEn.click(sel('new-project-more-render-server'));
  await pageEn.waitForSelector(`${sel('render-server-panel')}[data-mode="embedded"]`, { visible: true, timeout: 15_000 });
  await snap(pageEn, '05-en-render-server-embedded.png');
  await ctxEn.close();

  /* ======================================================================
   * P3: More -> Team Project (Member Accounts & LAN/WAN Discovery)
   * ====================================================================== */
  await pageA.click(sel('rs-back-btn'));
  await pageA.waitForSelector(sel('new-project-more-team'), { visible: true, timeout: 10_000 });
  await pageA.click(sel('new-project-more-team'));
  await pageA.waitForSelector(sel('team-members-editor'), { visible: true, timeout: 10_000 });

  await pageA.click(sel('team-tab-discover'));
  await pageA.waitForSelector(sel('team-discovery-panel'), { visible: true, timeout: 10_000 });
  await pageA.waitForFunction(
    () => !document.querySelector('[data-pc="team-lan-scan-btn"]')?.hasAttribute('disabled'),
    { timeout: 15_000 },
  );
  await snap(pageA, '06-zh-team-discovery.png');

  /* ======================================================================
   * P4: Create Personal Local Project + Personal Project Conversion Buttons
   *     on BOTH StartPage (`sp-draft`) and Vibe DesktopStart (`RowMenu`)
   * ====================================================================== */
  await pageA.click(sel('new-project-choice-local'));
  await setInputValue(pageA, sel('new-project-name'), 'Personal_Cut_Alpha');
  await pageA.click(sel('new-project-local-confirm'));
  await pageA.waitForSelector(sel('editor'), { visible: true, timeout: 45_000 });

  // Return to Classic StartPage via Home event; local draft is already saved on creation
  await pageA.evaluate(() => {
    window.dispatchEvent(new Event('pc-go-home'));
  });
  await pageA.waitForSelector('.sp-draft', { visible: true, timeout: 25_000 });
  await pageA.$eval('.sp-draft', (el) => el.scrollIntoView({ block: 'center' }));

  const draftButtons = await pageA.evaluate(() => ({
    switchOnline: document.querySelector('[data-pc="draft-switch-online"]')?.textContent?.trim(),
    convertTeam: document.querySelector('[data-pc="draft-convert-team"]')?.textContent?.trim(),
  }));
  check(
    draftButtons.switchOnline === '\u6362\u4e3a\u5728\u7ebf\u9879\u76ee' && draftButtons.convertTeam === '\u8f6c\u4e3a\u56e2\u961f\u9879\u76ee',
    'P4a StartPage local draft card shows Switch to online project & Convert to team project',
    draftButtons,
  );
  await snap(pageA, '07-zh-startpage-draft-conversions.png');

  // Verify Vibe DesktopStart (`?ui=vibe`) New Project modal + RowMenu conversion buttons
  const pageVibe = await ctxHostA.newPage();
  await pageVibe.setViewport({ width: 1280, height: 860 });
  attachErrorListeners(pageVibe, 'hostA-vibe');
  await pageVibe.goto(`${serverA.origin}/?ui=vibe&nosetup=1&lang=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pageVibe.waitForSelector(sel('start-side-new'), { visible: true, timeout: 30_000 });
  await pageVibe.click(sel('start-side-new'));
  await pageVibe.waitForSelector(sel('new-project-dialog'), { visible: true, timeout: 15_000 });
  await setInputValue(pageVibe, sel('new-project-name'), 'Vibe_Personal_Demo');
  await pageVibe.click(sel('new-project-local-confirm'));
  await pageVibe.waitForFunction(() => !document.querySelector('[data-pc="new-project-dialog"]'), { timeout: 25_000 });
  await pageVibe.waitForSelector(sel('start-side-project'), { visible: true, timeout: 25_000 });
  await sleep(300);

  // Open context menu on Vibe project row
  const vibeRow = await pageVibe.$(sel('start-side-project'));
  const vibeBox = await vibeRow.boundingBox();
  await pageVibe.mouse.click(vibeBox.x + vibeBox.width / 2, vibeBox.y + vibeBox.height / 2, { button: 'right' });
  await pageVibe.waitForSelector(sel('start-menu-switch-online'), { visible: true, timeout: 10_000 });
  const vibeMenu = await pageVibe.evaluate(() => ({
    switchOnline: document.querySelector('[data-pc="start-menu-switch-online"]')?.textContent?.trim(),
    convertTeam: document.querySelector('[data-pc="start-menu-convert-team"]')?.textContent?.trim(),
  }));
  check(
    vibeMenu.switchOnline === '\u6362\u4e3a\u5728\u7ebf\u9879\u76ee' && vibeMenu.convertTeam === '\u8f6c\u4e3a\u56e2\u961f\u9879\u76ee',
    'P4b Vibe DesktopStart row menu shows Switch to online project & Convert to team project',
    vibeMenu,
  );
  await snap(pageVibe, '08-zh-vibe-row-menu-conversions.png');
  await pageVibe.close();

  /* ======================================================================
   * P5: Convert Personal Draft to Team Project + Become Render Server
   * ====================================================================== */
  await pageA.bringToFront();
  await pageA.click(sel('draft-convert-team'));
  await pageA.waitForSelector(sel('new-project-team-view'), { visible: true, timeout: 15_000 });

  await setInputValue(pageA, sel('team-creator-username'), 'creator_lin');
  await setInputValue(pageA, sel('team-creator-password'), 'creator-pass-123');

  // Add rw member `alice`
  await setInputValue(pageA, sel('team-member-user-input'), 'alice');
  await setInputValue(pageA, sel('team-member-pw-input'), 'alice-pass-123');
  await setInputValue(pageA, sel('team-member-access-select'), 'rw');
  await pageA.click(sel('team-member-add-btn'));

  // Add read-only member `viewer_ro`
  await setInputValue(pageA, sel('team-member-user-input'), 'viewer_ro');
  await setInputValue(pageA, sel('team-member-pw-input'), 'ro-pass-123');
  await setInputValue(pageA, sel('team-member-access-select'), 'r');
  await pageA.click(sel('team-member-add-btn'));

  const chipCount = await pageA.$$eval(sel('team-member-chip'), (els) => els.length);
  check(chipCount === 2, 'P5a Added 2 member accounts (rw + r) before converting draft', chipCount);

  await pageA.click(sel('new-project-team-confirm'));
  await pageA.waitForSelector(sel('editor'), { visible: true, timeout: 45_000 });
  await sleep(800);

  // Open Project Settings on Host A (Creator) -> verify BOTH server role buttons + read invite link
  await openProjectSettings(pageA);
  const inviteLinkOnA = await pageA.$eval(sel('collab-invite-link'), (el) => el.textContent.trim()).catch(() => '');
  check(Boolean(inviteLinkOnA && inviteLinkOnA.includes('#invite=')), 'P5b Team project created with invite link', inviteLinkOnA);
  const creatorRoles = await pageA.evaluate(() => ({
    renderBtn: Boolean(document.querySelector('[data-pc="settings-become-render-server"]')),
    dataBtn: Boolean(document.querySelector('[data-pc="settings-become-data-server"]')),
  }));
  check(creatorRoles.renderBtn && creatorRoles.dataBtn, 'P5c Creator sees both Become render server and Become data server', creatorRoles);
  await snap(pageA, '09-zh-project-settings-creator-roles.png');

  // Click "Become render server" -> switches workspace to RenderServerPanel
  await pageA.click(sel('settings-become-render-server'));
  await pageA.waitForSelector(`${sel('render-server-panel')}[data-mode="workspace"]`, { visible: true, timeout: 15_000 });
  // Bind current project via "Add joined project" known candidate button if offered, or verify bound list
  const hasKnownAdd = await pageA.$(sel('rs-add-known-btn'));
  if (hasKnownAdd) {
    await hasKnownAdd.click();
    await pageA.waitForSelector(sel('rs-bound-project'), { visible: true, timeout: 15_000 });
  }
  await snap(pageA, '10-zh-workspace-render-server.png');

  // Return to editor via rs-back-btn
  await pageA.click(sel('rs-back-btn'));
  await pageA.waitForSelector(sel('editor'), { visible: true, timeout: 15_000 });
  const hasRolePillA = Boolean(await pageA.$(sel('server-role-pill')));
  check(hasRolePillA, 'P5d Floating server-role-pill remains accessible after returning to editor');

  /* ======================================================================
   * P6: Issue #8 Non-Creator Visibility Gate (`alice` sees NO Become Data Server)
   * ====================================================================== */
  const ctxAlice = await browser.createBrowserContext();
  const pageAlice = await ctxAlice.newPage();
  await pageAlice.setViewport({ width: 1280, height: 860 });
  attachErrorListeners(pageAlice, 'member-alice');

  await pageAlice.goto(`${serverA.origin}/?lang=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pageAlice.waitForSelector('.sp-hero', { visible: true, timeout: 30_000 });
  await pageAlice.click('.sp-hero');
  await pageAlice.waitForSelector(sel('new-project-choice-more'), { visible: true, timeout: 15_000 });
  await pageAlice.click(sel('new-project-choice-more'));
  await pageAlice.waitForSelector(sel('new-project-more-team'), { visible: true, timeout: 10_000 });
  await pageAlice.click(sel('new-project-more-team'));
  await pageAlice.waitForSelector(sel('team-tab-discover'), { visible: true, timeout: 10_000 });
  await pageAlice.click(sel('team-tab-discover'));
  await pageAlice.waitForSelector(sel('team-discovered-item'), { visible: true, timeout: 15_000 });
  await setInputValue(pageAlice, sel('team-join-username'), 'alice');
  await setInputValue(pageAlice, sel('team-join-password'), 'alice-pass-123');
  await pageAlice.click(sel('team-join-submit'));
  await pageAlice.waitForSelector(sel('editor'), { visible: true, timeout: 45_000 });

  await openProjectSettings(pageAlice);
  const aliceRoles = await pageAlice.evaluate(() => ({
    renderBtn: Boolean(document.querySelector('[data-pc="settings-become-render-server"]')),
    dataBtn: Boolean(document.querySelector('[data-pc="settings-become-data-server"]')),
  }));
  check(
    aliceRoles.renderBtn === true && aliceRoles.dataBtn === false,
    'P6 Non-creator member alice sees Become render server, and Become data server is strictly hidden',
    aliceRoles,
  );
  await snap(pageAlice, '11-zh-project-settings-member-gated.png');
  await ctxAlice.close();

  /* ======================================================================
   * P7: Multi-Machine Invite Binding + Creator Handover (Approval + 6-Digit
   *     Pairing Code) + DataServerPanel + Join Own Project in Editor
   * ====================================================================== */
  const ctxHostB = await browser.createBrowserContext();
  const pageB = await ctxHostB.newPage();
  await pageB.setViewport({ width: 1280, height: 860 });
  attachErrorListeners(pageB, 'hostB-zh');

  await pageB.goto(`${serverB.origin}/?lang=zh-CN`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pageB.waitForSelector('.sp-hero', { visible: true, timeout: 45_000 });

  // 7a: Bind Host A's invite link in Host B's Render Server Panel ("Add invite link")
  await pageB.click('.sp-hero');
  await pageB.waitForSelector(sel('new-project-choice-more'), { visible: true, timeout: 15_000 });
  await pageB.click(sel('new-project-choice-more'));
  await pageB.waitForSelector(sel('new-project-more-render-server'), { visible: true, timeout: 10_000 });
  await pageB.click(sel('new-project-more-render-server'));
  await pageB.waitForSelector(sel('rs-add-invite-tab'), { visible: true, timeout: 15_000 });
  await pageB.click(sel('rs-add-invite-tab'));
  await setInputValue(pageB, sel('rs-invite-input'), inviteLinkOnA);
  await setInputValue(pageB, sel('rs-invite-username'), 'alice');
  await setInputValue(pageB, sel('rs-invite-password'), 'alice-pass-123');
  await pageB.click(sel('rs-invite-submit'));
  await pageB.waitForSelector(sel('rs-bound-project'), { visible: true, timeout: 20_000 });
  const boundCountB = await pageB.$$eval(sel('rs-bound-project'), (els) => els.length);
  check(boundCountB >= 1, 'P7a Host B Render Server bound project via invite link', boundCountB);
  await snap(pageB, '12-zh-render-server-invite-bound.png');

  // Remove invite binding before Host B joins as Creator so render worker and creator session stay distinct
  await pageB.click(sel('rs-remove-project'));
  await sleep(400);

  // 7b: Join Host A's team project on Host B as Creator via Team Discovery (WAN/Direct lookup)
  await pageB.click(sel('rs-back-btn'));
  await pageB.waitForSelector(sel('new-project-more-team'), { visible: true, timeout: 10_000 });
  await pageB.click(sel('new-project-more-team'));
  await pageB.waitForSelector(sel('team-tab-discover'), { visible: true, timeout: 10_000 });
  await pageB.click(sel('team-tab-discover'));
  await setInputValue(pageB, sel('team-wan-name-input'), 'Personal_Cut_Alpha');
  await setInputValue(pageB, sel('team-wan-url-input'), serverA.origin);
  await pageB.click(sel('team-wan-search-btn'));
  await pageB.waitForSelector(sel('team-discovered-item'), { visible: true, timeout: 15_000 });
  await setInputValue(pageB, sel('team-join-username'), 'creator_lin');
  await setInputValue(pageB, sel('team-join-password'), 'creator-pass-123');
  // Check "Sign in as project creator"
  await pageB.$eval('[data-pc="team-discovery-panel"] input[type="checkbox"]', (el) => {
    if (!el.checked) el.click();
  });
  await pageB.click(sel('team-join-submit'));
  await pageB.waitForSelector(sel('editor'), { visible: true, timeout: 45_000 });
  await sleep(1000); // Allow presence handshake between Host A and Host B to settle

  // 7c: Initiate "Become data server" on Host B
  await openProjectSettings(pageB);
  await pageB.waitForSelector(sel('settings-become-data-server'), { visible: true, timeout: 10_000 });
  await pageB.$eval(sel('settings-become-data-server'), (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(250);
  await pageB.click(sel('settings-become-data-server'));
  await pageB.waitForSelector(sel('handover-requester-dialog'), { visible: true, timeout: 15_000 });

  // 7d: Original creator machine (Host A) pops up Approval Dialog ("是否同意移交数据服务器？")
  await pageA.waitForSelector(sel('handover-approval-dialog'), { visible: true, timeout: 20_000 });
  await snap(pageA, '13-zh-host-a-handover-approval.png');

  await pageA.click(sel('handover-agree'));
  await pageA.waitForSelector(sel('handover-host-code'), { visible: true, timeout: 15_000 });
  const pairingCode = await pageA.$eval(sel('handover-host-code'), (el) => el.textContent.trim());
  check(/^\d{6}$/.test(pairingCode), 'P7b Host A generated 6-digit pairing code after Agree', pairingCode);
  await snap(pageA, '14-zh-host-a-pairing-code.png');

  // 7e: Host B enters wrong pairing code first -> rejected, then enters matching 6-digit code -> verified
  await pageB.waitForSelector(sel('handover-code-input'), { visible: true, timeout: 15_000 });
  const wrongCode = pairingCode === '000000' ? '999999' : '000000';
  await setInputValue(pageB, sel('handover-code-input'), wrongCode);
  await pageB.click(sel('handover-verify-submit'));
  await pageB.waitForSelector(sel('handover-code-error'), { visible: true, timeout: 10_000 });

  await setInputValue(pageB, sel('handover-code-input'), pairingCode);
  await pageB.click(sel('handover-verify-submit'));
  await pageB.waitForSelector(sel('handover-requester-verified'), { visible: true, timeout: 10_000 });
  await snap(pageB, '15-zh-host-b-pairing-verified.png');

  // 7f: Host A confirms transfer -> Host B adopts room onto local /docservice and opens DataServerPanel
  await pageA.waitForSelector(sel('handover-host-confirm'), { visible: true, timeout: 10_000 });
  await pageA.click(sel('handover-host-confirm'));

  await pageB.waitForSelector(sel('data-server-panel'), { visible: true, timeout: 30_000 });
  await pageB.waitForFunction(
    () => document.querySelectorAll('[data-pc="ds-member-row"]').length >= 2,
    { timeout: 15_000 },
  );

  // Add member `bob` inside DataServerPanel
  await setInputValue(pageB, sel('ds-member-username'), 'bob');
  await setInputValue(pageB, sel('ds-member-password'), 'bob-pass-123');
  await pageB.click(sel('ds-add-member-btn'));
  await pageB.waitForSelector('[data-pc="ds-member-row"][data-username="bob"]', { visible: true, timeout: 15_000 });

  const dsMembers = await pageB.$$eval('[data-pc="ds-member-row"]', (els) =>
    els.map((e) => ({
      username: e.getAttribute('data-username'),
      text: e.textContent.replace(/\s+/g, ' ').trim(),
    })),
  );
  const viewerRow = dsMembers.find((m) => m.username === 'viewer_ro');
  check(
    dsMembers.some((m) => m.username === 'alice') &&
      Boolean(viewerRow && viewerRow.text.includes('只读')) &&
      dsMembers.some((m) => m.username === 'bob'),
    'P7c DataServerPanel preserved existing allowlist (including viewer_ro Read-only) and added bob',
    dsMembers,
  );
  await snap(pageB, '16-zh-data-server-panel.png');

  // 7g: Click "Join own project in editor" (`data-server-open-editor`) -> edit own hosted project -> verify revision history
  await pageB.click(sel('data-server-open-editor'));
  await pageB.waitForFunction(() => !document.querySelector('[data-pc="data-server-panel"]'), { timeout: 10_000 });
  await pageB.waitForSelector(sel('editor'), { visible: true, timeout: 15_000 });

  const sharedBaseOnB = await pageB.evaluate(() => {
    const raw = sessionStorage.getItem('pc.shared.resume');
    return raw ? JSON.parse(raw)?.candidate?.base : null;
  });
  check(
    sharedBaseOnB === `${serverB.origin}/docservice`,
    'P7d Host B editor is actively connected to its own local data server /docservice',
    sharedBaseOnB,
  );

  // Make a real project edit in Host B's editor (change FPS to 60 in Project Settings)
  await openProjectSettings(pageB);
  await setInputValue(pageB, sel('fps-select'), '60');
  await pageB.click('.pc-dialog--collab .pc-dialog-foot .pc-btn--primary');
  await pageB.waitForFunction(() => !document.querySelector('.pc-dialog--collab'), { timeout: 10_000 });
  await sleep(1000);
  await snap(pageB, '17-zh-data-server-joined-editor.png');

  // Reopen Data Server Panel via floating pill and verify commit appears in modification history
  await pageB.waitForSelector(sel('server-role-pill'), { visible: true, timeout: 10_000 });
  await pageB.click(sel('server-role-pill'));
  await pageB.waitForSelector(sel('data-server-panel'), { visible: true, timeout: 15_000 });
  await pageB.click(sel('ds-refresh-btn'));
  await pageB.waitForSelector(sel('ds-history-row'), { visible: true, timeout: 15_000 });

  const historyRows = await pageB.$$eval(sel('ds-history-row'), (els) =>
    els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
  );
  check(
    historyRows.length >= 1 && historyRows.some((t) => t.includes('creator_lin')),
    'P7e DataServerPanel modification history records edit made from Data Server own editor',
    historyRows,
  );
  await snap(pageB, '18-zh-data-server-history-recorded.png');

  // Also capture English Data Server Panel & Project Settings roles on Host B (unshared self-host quick check)
  const ctxHostBEn = await browser.createBrowserContext();
  const pageBEn = await ctxHostBEn.newPage();
  await pageBEn.setViewport({ width: 1280, height: 860 });
  attachErrorListeners(pageBEn, 'hostB-en');
  await pageBEn.goto(`${serverB.origin}/?editor&lang=en`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pageBEn.waitForSelector(sel('editor'), { visible: true, timeout: 45_000 });
  await openProjectSettings(pageBEn);
  await pageBEn.waitForSelector(sel('settings-become-data-server'), { visible: true, timeout: 10_000 });
  await pageBEn.$eval(sel('settings-become-data-server'), (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(250);
  await snap(pageBEn, '19-en-project-settings-creator-roles.png');
  await pageBEn.click(sel('settings-become-data-server'));
  await pageBEn.waitForSelector(sel('data-server-panel'), { visible: true, timeout: 30_000 });
  await snap(pageBEn, '20-en-data-server-panel.png');
  await ctxHostBEn.close();

  await ctxHostB.close();
  await ctxHostA.close();

  check(pageErrors.length === 0, 'L5 zero uncaught page errors across all contexts', pageErrors);
} catch (err) {
  fails.push(`Fatal probe error: ${err?.stack || err}`);
  if (pageErrors.length > 0) fails.push(`Page errors before crash: ${JSON.stringify(pageErrors)}`);
  if (consoleErrors.length > 0) fails.push(`Console errors before crash: ${JSON.stringify(consoleErrors)}`);
  try {
    for (const item of activePages) {
      if (!item.page.isClosed()) {
        await item.page.screenshot({ path: path.join(SHOTS, `99-debug-${item.tag}.png`) }).catch(() => {});
      }
    }
  } catch {}
} finally {
  try { await browser?.close(); } catch {}
  try { serverA?.stop(); } catch {}
  try { serverB?.stop(); } catch {}
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}

const ok = fails.length === 0;
console.log(JSON.stringify({
  ok,
  fails,
  shotsDir: SHOTS,
  shotCount: shotFiles.length,
  hostAPort: serverA?.port ?? null,
  hostBPort: serverB?.port ?? null,
}));
process.exit(ok ? 0 : 1);
