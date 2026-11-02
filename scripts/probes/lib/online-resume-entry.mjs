/**
 * Shared across probes: enters a passphrase-based shared project on an online page without going
 * through the form on the start page.
 *
 * Since 2026-10, the start page of online builds only has an account entry point
 * (`src/account/AccountProjects.tsx`), and the "Join another person's project" form
 * (`[data-pc="join-form"]`) is no longer included in the online build; probes written against it
 * (such as the node role in `m7-node-probe.mjs`, `m7-browser-probe.mjs`) cannot wait for the form
 * at the very first step. Passphrase-based shared projects still exist on the server side and in
 * the page: the page has an existing product path: "return to the shared project open before refresh
 * after refreshing the same tab" (`resumeShared` in `src/editor/sync/syncManager.ts`, `Shell.tsx`
 * checks `sessionStorage['pc.shared.resume']` on startup). Here, before the page loads, that record
 * is placed into sessionStorage (only storing derived K, not the passphrase), and the page enters
 * just like "return to project after refresh". Injects no page code, modifies no network requests
 * of the page.
 *
 *   const record = await resumeRecord({ base, projectId, name, username, password, deviceId });
 *   await plantResume(page, record);      // before page.goto
 *   await page.goto(editorUrl);           // page enters the project on its own, wait for `[data-pc="members-button"]`
 */
import { buildAuthProtocols, redeemInvite } from '../../../server/auth/client.mjs';

/** Key for that record in sessionStorage (same as `SHARED_RESUME_KEY` in `syncManager.ts`). */
export const SHARED_RESUME_KEY = 'pc.shared.resume';

/**
 * Computes the "project open before refresh" record: fetches a challenge from the document
 * service and derives K from the project passphrase (same algorithm used when the page enters
 * on its own, `server/auth/client.mjs`).
 * `base` is the document service address seen by the page (ending with `/`, e.g.
 * `http://pc.localhost:5810/hosted/`); if `derivationBase` is provided, it is used to fetch
 * the challenge (direct connection from Node).
 * @returns {Promise<{ candidate: object, as: 'member' | 'creator', username: string, key: string }>}
 */
export async function resumeRecord({ base, derivationBase = base, projectId, name, username, password, deviceId, as = 'member', mode = 'free' }) {
  let key = null;
  await buildAuthProtocols({ base: derivationBase, projectId, username, deviceId, deviceName: 'probe-resume', as, password, role: 'page', onKey: (k) => { key = k; } });
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Cannot derive K for the project passphrase');
  return { candidate: { where: 'hosted', base: base.endsWith('/') ? base : `${base}/`, projectId, name, mode }, as, username, key };
}

/**
 * Redeems the "project open before refresh" record with an invite code: calls `shared/invite/redeem`
 * on the document service (same endpoint as entering with an invite code on the start page),
 * obtains K for the project passphrase, and packages it into a session resume record.
 */
export async function resumeRecordFromInvite({ base, derivationBase = base, code, username, deviceId, as = 'member' }) {
  const red = await redeemInvite({ base: derivationBase, code, username, deviceId });
  if (typeof red.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(red.key)) throw new Error('Redeeming the invite code did not yield K for the project passphrase');
  return { candidate: { where: 'hosted', base: base.endsWith('/') ? base : `${base}/`, projectId: red.projectId, name: red.name, mode: red.mode }, as, username, key: red.key };
}

/** Puts the record into the top-level document's sessionStorage before the page loads (skips stage iframes; leaves untouched if a record already exists). */
export async function plantResume(page, record, storageKey = SHARED_RESUME_KEY) {
  await page.evaluateOnNewDocument((k, r) => {
    try { if (window.top === window && !sessionStorage.getItem(k)) sessionStorage.setItem(k, r); } catch { /* Cannot store: page remains on the start page, probe cannot wait for the member button */ }
  }, storageKey, JSON.stringify(record));
}

/**
 * Switches an open online editor page to another shared project without a full-page refresh
 * (preserving module-level state of this page, such as the connection count in `measureGate`):
 * first disconnects the current shared connection with `newProject`, then writes the resume record
 * for the new project and calls `resumeShared()` on `syncManager`.
 */
export async function switchSharedInPlace(page, record, storageKey = SHARED_RESUME_KEY) {
  await page.evaluate(async (k, r) => {
    window.__pcStore?.actions?.newProject?.('Untitled');
    sessionStorage.setItem(k, r);
    const resUrl = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/assets\/syncManager-.*\.js$/.test(n));
    const mod = await import(resUrl || '/src/editor/sync/syncManager.ts');
    const fn = mod.resumeShared || Object.values(mod).find((v) => typeof v === 'function' && /docProjectId.*candidate\.projectId/.test(String(v)));
    if (typeof fn !== 'function') throw new Error('Cannot find resumeShared');
    await fn();
  }, storageKey, JSON.stringify(record));
}
