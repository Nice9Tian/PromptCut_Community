/**
 * Shared local environment for mobile app probes (`mobile-ui-probe.mjs`, `mobile-business-probe.mjs`):
 * Local document service + asset service (`probe-services.mjs`, data directory in system temp
 * directory) + nginx-mocking proxy (`hosted-proxy.mjs`, three same-site cross-origin origins)
 * + online build as pages, without connecting to any remote host. Passphrase-based shared projects
 * enter via the "return to project after refresh" product path (`online-resume-entry.mjs`).
 *
 *   const env = await startMobileEnv({ dist, basePort, docPort, assetPort, name });
 *   const page = await env.newPage(browser, 'phone' | 'desktop' | 'iphone' | 'ipad' | 'none');
 *   await env.enter(page, { layout });   // enter project; includes ?layout= if layout is provided
 *   await env.close();
 *
 * Device emulation: identity (UA) sets `userAgentData` via CDP's `Emulation.setUserAgentOverride`
 * as well (Chromium-based browsers use it to identify phones), viewport 375×812, touchscreen.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { startProbeServices } from './probe-services.mjs';
import './localhost-dns.cjs';
import { startHostedProxy, proxyOrigins } from './hosted-proxy.mjs';
import { resumeRecord, plantResume } from './online-resume-entry.mjs';
import { createSharedProject, buildAuthProtocols } from '../../../server/auth/client.mjs';

export const DEVICES = {
  phone: {
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    meta: { brands: [{ brand: 'Chromium', version: '140' }, { brand: 'Google Chrome', version: '140' }], fullVersion: '140.0.0.0', platform: 'Android', platformVersion: '14', architecture: '', model: 'Pixel 8', mobile: true },
    viewport: { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  },
  desktop: {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    meta: { brands: [{ brand: 'Chromium', version: '140' }, { brand: 'Google Chrome', version: '140' }], fullVersion: '140.0.0.0', platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', model: '', mobile: false },
    viewport: { width: 1600, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  },
};

export async function startMobileEnv({ dist, basePort, base2Port, docPort, assetPort, name, log = () => {}, startServices = startProbeServices }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-probe-hosted-'));
  const origin = proxyOrigins(basePort).editor;
  const docDirect = `http://127.0.0.1:${docPort}`;
  const combo = await startServices({
    dataDir, docPort, assetPort, host: '127.0.0.1',
    docPublicUrl: `ws://pc.localhost:${basePort}/hosted/`, assetPublicUrl: `${origin}/media/api/asset`, log,
  });
  const proxy = await startHostedProxy({ dist, basePort, docPort, assetPort, policy: 'full' });
  /** Second identical proxy instance (used by another member; when only the first instance is disconnected, the second remains online as usual). */
  const proxy2 = base2Port ? await startHostedProxy({ dist, basePort: base2Port, docPort, assetPort, policy: 'full' }) : null;
  const origin2 = base2Port ? proxyOrigins(base2Port).editor : null;
  const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
  const projectPw = `pw-${randomBytes(6).toString('hex')}`;
  const made = await createSharedProject({ base: docDirect, name, mode: 'free', creator, password: projectPw });

  /** Connects directly to the document service as creator, writing initial content on behalf of the creator's desktop app (online pages only join, never create new). */
  async function seed(body) {
    const protocols = await buildAuthProtocols({ base: docDirect, projectId: made.projectId, username: creator.username, deviceId: 'mobile-probe-seed-01', deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
    const ws = new WebSocket(docDirect.replace(/^http/, 'ws'), protocols);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    const ask = (msg) => new Promise((resolve) => {
      const reqId = `p${Math.random().toString(36).slice(2)}`;
      const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ ...msg, reqId }));
    });
    const opened = await ask({ type: 'project.open', projectId: made.projectId });
    const seeded = await ask({ type: 'project.op', projectId: made.projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
    ws.close();
    return { opened: opened?.type, seeded: seeded?.type };
  }

  let joinSeq = 0;
  async function newPage(browser, device) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.errors = [];
    page.consoleErrors = [];
    page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e)));
    page.on('console', (m) => { if (m.type() === 'error') page.consoleErrors.push(page.phase ? `${page.phase}|${m.text()}` : m.text()); });
    page.badResponses = [];
    page.on('response', (r) => { if (r.status() >= 400) page.badResponses.push(`${r.status()} ${r.url()}`); });
    const d = DEVICES[device];
    if (d) {
      await page.setViewport(d.viewport);
      const cdp = await page.createCDPSession();
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: d.ua, userAgentMetadata: d.meta });
      if (d.viewport.hasTouch) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      page.cdp = cdp;
    } else {
      await page.setViewport({ width: 1280, height: 800 });
      page.cdp = await page.createCDPSession();
    }
    return page;
  }

  async function enter(page, { layout, username = `m${++joinSeq}`, wait = 'auto', via = 1 } = {}) {
    const o = via === 2 ? origin2 : origin;
    await plantResume(page, await resumeRecord({
      base: `${o}/hosted/`, derivationBase: `${docDirect}/`, projectId: made.projectId, name,
      username, password: projectPw, deviceId: `mobile-${username}-${Date.now().toString(36)}`.padEnd(16, '0').slice(0, 40),
    }));
    await page.goto(`${o}/editor${layout ? `?layout=${layout}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const sel = wait === 'auto' ? '[data-pcm="editor"], [data-pc="members-button"]' : wait;
    await page.waitForSelector(sel, { visible: true, timeout: 90_000 });
  }

  async function close() {
    await proxy.close?.().catch?.(() => {});
    await proxy2?.close?.().catch?.(() => {});
    await combo.close?.().catch?.(() => {});
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Handles still remain on Windows: left for the system to clean up */ }
  }

  return { origin, origin2, proxy, proxy2, made, docDirect, seed, newPage, enter, close, creator, combo };
}

/** Waits for the full-screen "Measuring cards" overlay to exit: after adding a card it covers the entire page, and any click during this time hits the overlay. */
export const gateClear = (page, ms = 60_000) => page.waitForFunction(() => !document.querySelector('.pc-probe-gate'), { timeout: ms }).catch(() => {});

/** An empty project (dimensions and duration match the "New project" defaults), two tracks, two cuts. */
export function emptyProject(name) {
  return {
    version: 1, id: `mobile-seed-${Date.now().toString(36)}`, name, width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'midnight', media: [],
    tracks: [{ id: 't-1', name: 'Track 1', clips: [] }, { id: 't-2', name: 'Track 2', clips: [] }],
    cuts: [{ id: 'cut-1', name: 'Cut 1' }, { id: 'cut-2', name: 'Intro', tracks: [{ id: 't-a', name: 'Track 1', clips: [] }], duration: 3 }],
    activeCutId: 'cut-1',
  };
}

/** Draws a solid-color PNG (used for asset import). */
export async function solidPng(file, [r, g, b], w = 320, h = 180) {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) { png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b; png.data[i * 4 + 3] = 255; }
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}
