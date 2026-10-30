/** Real Home UI during each awaited recovery phase. Only the invoking probe's rooms and pages. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from '../../server/test/fake-ws-kit.mjs';

export async function runRecoveryExitMatrix(o) {
  let { host, member } = o;
  const { root, where, roomId, hostFile, memberFile, hostRuntime, memberRuntime, page, open, connected, cloud, phase } = o;
  const cases = [
    { phase: 'identity', who: 'host', matches: p => p === '/api/collaboration/select' },
    ...(where === 'lan' ? [
      { phase: 'host', who: 'host', matches: p => p === '/api/collaboration/restore-host' },
      { phase: 'discover', who: 'member', matches: p => p === '/api/docservice/lan-discover' },
      { phase: 'enter-and-register', who: 'host', matches: p => p === '/api/collaboration/activate-host' },
    ] : [{ phase: 'enter', who: 'member', matches: p => p.endsWith('/shared/challenge') }]),
  ];
  const results = [];
  for (const test of cases) {
    phase(`actual Home UI rejects a delayed ${test.phase} recovery result`);
    const actor = test.who === 'host' ? host : member;
    const file = test.who === 'host' ? hostFile : memberFile;
    let held, response;
    await actor.setRequestInterception(true);
    const intercept = req => {
      if (!held && req.method() !== 'OPTIONS' && test.matches(new URL(req.url()).pathname)) held = req;
      else void req.continue().catch(() => {});
    };
    actor.on('request', intercept);
    try {
      await open(actor, file);
      await waitFor(() => held, 10000, 'isolated recovery request to delay');
      // Execute on the real isolated service, but hold its answer until after the Home action.
      // The body may contain protected capabilities; keep it only in memory and never log it.
      const actual = await fetch(held.url(), { method: held.method(), headers: held.headers(),
        ...(held.method() === 'POST' ? { body: held.postData() } : {}), redirect: 'error' });
      assert.equal(actual.ok, true, `isolated ${test.phase} response must succeed before it becomes late`);
      const headers = Object.fromEntries(actual.headers); delete headers['content-length']; delete headers['content-encoding']; delete headers['transfer-encoding'];
      response = { status: actual.status, headers, body: Buffer.from(await actual.arrayBuffer()) };
      if (test.phase !== 'enter-and-register') {
        await actor.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
        await actor.waitForSelector('[data-pc="collab-toggle"]');
        assert.equal(await actor.$eval('[data-pc="collab-toggle"]', el => el.disabled), true, 'unconfirmed identity cannot cancel a room');
        await actor.evaluate(() => [...document.querySelectorAll('.pc-dialog button')].find(b => b.textContent?.trim() === '取消').click());
      }
      actor.once('dialog', d => void d.accept());
      await actor.click('button[title="首页"]');
      await actor.waitForSelector('[data-pc="start-join"]');
      await held.respond(response).catch(() => {}); response = null;
      await new Promise(r => setTimeout(r, 800));
      assert.deepEqual(await actor.evaluate(() => {
        const v = window.probe.sync.getSyncView();
        return { shared: !!v.shared, taskState: v.reopenState, link: !!window.probe.sync.currentSharedLink(), resume: !!sessionStorage.getItem('pc.shared.resume') };
      }), { shared: false, taskState: null, link: false, resume: false });
      await actor.waitForFunction(async () => {
        const agent = await (await fetch('/api/agent/status')).json(), cards = await (await fetch('/api/cards/sync/status')).json(), render = await (await fetch('/api/render-node/status')).json();
        return !agent.bound && cards.local && !render.binding;
      }, { timeout: 10000 });
      let hostRegistrationStopped = null;
      if (test.who === 'host' && where === 'lan') {
        await waitFor(async () => !(await cloud.hosting.online(roomId)), 10000, 'Home cancels actual host registration');
        hostRegistrationStopped = true;
      }
      await actor.screenshot({ path: path.join(root, `exit-${where}-${test.phase}-home.png`) });
      await actor.reload({ waitUntil: 'domcontentloaded' }); await actor.waitForSelector('[data-pc="start-join"]');
      results.push({ phase: test.phase, who: test.who, realServiceResponseDelayed: true, homeUi: true, lateResultIgnored: true,
        nodeBindingsRemoved: true, refreshStaysHome: true, hostRegistrationStopped });
    } finally {
      actor.off('request', intercept); await actor.setRequestInterception(false); response = null;
    }
    await actor.close();
    if (test.who === 'host') { host = await page(hostRuntime.base); await open(host, hostFile); await connected(host, roomId, 'host'); }
    else { member = await page(memberRuntime.base); await open(member, memberFile); await connected(member, roomId, 'member'); }
    await connected(member, roomId, 'member');
  }
  return { host, member, evidence: { where, cases: results, unsupportedPhases: where === 'hosted' ? ['local-host: cloud is the host', 'lan-discovery: trusted hosted candidate has no LAN discovery'] : [] } };
}
