/**
 * 手机版探针共用的本机环境(`mobile-ui-probe.mjs`、`mobile-business-probe.mjs`):
 * 本机文档服务 + 素材服务(`probe-services.mjs`,数据目录在系统临时目录)+ 仿 nginx 的代理(`hosted-proxy.mjs`,三个同站跨源的源)+ 在线构建当页面,
 * 不连任何远端。凭口令的共享项目经「刷新后回到项目」那条产品路径进入(`online-resume-entry.mjs`)。
 *
 *   const env = await startMobileEnv({ dist, basePort, docPort, assetPort, name });
 *   const page = await env.newPage(browser, 'phone' | 'desktop' | 'iphone' | 'ipad' | 'none');
 *   await env.enter(page, { layout });   // 进项目;layout 给了就带 ?layout=
 *   await env.close();
 *
 * 设备仿真:标识(UA)用 CDP 的 `Emulation.setUserAgentOverride` 一并设 `userAgentData`(Chromium 系按它判手机),视口 375×812、触屏。
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
  /** 第二套同形代理(另一名成员走它;只断第一套时第二套照常在线) */
  const proxy2 = base2Port ? await startHostedProxy({ dist, basePort: base2Port, docPort, assetPort, policy: 'full' }) : null;
  const origin2 = base2Port ? proxyOrigins(base2Port).editor : null;
  const creator = { username: 'boss', password: `boss-${randomBytes(6).toString('hex')}` };
  const projectPw = `pw-${randomBytes(6).toString('hex')}`;
  const made = await createSharedProject({ base: docDirect, name, mode: 'free', creator, password: projectPw });

  /** 凭创建者身份直连文档服务,替创建者的桌面版写进初始内容(在线页面只加入、不新建) */
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
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 上还有句柄:留给系统清 */ }
  }

  return { origin, origin2, proxy, proxy2, made, docDirect, seed, newPage, enter, close, creator, combo };
}

/** 一份空项目(尺寸、时长同「新建项目」的缺省),两条序列、两条剪辑 */
export function emptyProject(name) {
  return {
    version: 1, id: `mobile-seed-${Date.now().toString(36)}`, name, width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'midnight', media: [],
    tracks: [{ id: 't-1', name: '序列 1', clips: [] }, { id: 't-2', name: '序列 2', clips: [] }],
    cuts: [{ id: 'cut-1', name: '剪辑 1' }, { id: 'cut-2', name: '片头', tracks: [{ id: 't-a', name: '序列 1', clips: [] }], duration: 3 }],
    activeCutId: 'cut-1',
  };
}

/** 画一张纯色 PNG(素材导入用) */
export async function solidPng(file, [r, g, b], w = 320, h = 180) {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) { png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b; png.data[i * 4 + 3] = 255; }
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}
