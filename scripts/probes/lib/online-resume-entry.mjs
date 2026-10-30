/**
 * 探针共用:让在线页面进入一个凭口令的共享项目,不经开始页的表单。
 *
 * 2026-10 起在线构建的开始页只有账号入口(`src/account/AccountProjects.tsx`),「加入别人的项目」那张表单(`[data-pc="join-form"]`)
 * 不再进在线构建,照它写的探针(`m7-node-probe.mjs`、`m7-browser-probe.mjs` 的 node 角色等)在第一步就等不到表单。
 * 凭口令的共享项目在服务端和页面里都还在:页面有一条现成的产品路径 ——「同一个标签页刷新之后回到刷新前打开的共享项目」
 * (`src/editor/sync/syncManager.ts` 的 `resumeShared`,`Shell.tsx` 启动时看 `sessionStorage['pc.shared.resume']`)。
 * 这里在页面载入前把那条记录放进 sessionStorage(只放派生出的 K,不放口令),页面就照「刷新后回到项目」那样进去。
 * 不注入任何页面代码,不改页面的网络请求。
 *
 *   const record = await resumeRecord({ base, projectId, name, username, password, deviceId });
 *   await plantResume(page, record);      // 在 page.goto 之前
 *   await page.goto(editorUrl);           // 页面自己进项目,等 `[data-pc="members-button"]`
 */
import { buildAuthProtocols, redeemInvite } from '../../../server/auth/client.mjs';

/** sessionStorage 里那条记录的键(同 `syncManager.ts` 的 `SHARED_RESUME_KEY`) */
export const SHARED_RESUME_KEY = 'pc.shared.resume';

/**
 * 算出「刷新前开着这个项目」的记录:向文档服务取一次挑战、按项目口令派生 K(与页面自己进入时同一个算法,`server/auth/client.mjs`)。
 * `base` 是页面看到的文档服务地址(以 `/` 结尾,例如 `http://pc.localhost:5810/hosted/`);`derivationBase` 给了就用它取挑战(Node 这边直连)。
 * @returns {Promise<{ candidate: object, as: 'member' | 'creator', username: string, key: string }>}
 */
export async function resumeRecord({ base, derivationBase = base, projectId, name, username, password, deviceId, as = 'member', mode = 'free' }) {
  let key = null;
  await buildAuthProtocols({ base: derivationBase, projectId, username, deviceId, deviceName: 'probe-resume', as, password, role: 'page', onKey: (k) => { key = k; } });
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('派生不出项目口令的 K');
  return { candidate: { where: 'hosted', base: base.endsWith('/') ? base : `${base}/`, projectId, name, mode }, as, username, key };
}

/**
 * 凭邀请码兑换出「刷新前开着这个项目」的记录:向文档服务调 `shared/invite/redeem`(与开始页凭邀请码进入同一个端点),
 * 拿到项目口令的 K 后装成会话恢复记录。
 */
export async function resumeRecordFromInvite({ base, derivationBase = base, code, username, deviceId, as = 'member' }) {
  const red = await redeemInvite({ base: derivationBase, code, username, deviceId });
  if (typeof red.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(red.key)) throw new Error('邀请码兑换不出项目口令的 K');
  return { candidate: { where: 'hosted', base: base.endsWith('/') ? base : `${base}/`, projectId: red.projectId, name: red.name, mode: red.mode }, as, username, key: red.key };
}

/** 页面载入前把记录放进顶层文档的 sessionStorage(舞台 iframe 不放;已经有记录就不动) */
export async function plantResume(page, record, storageKey = SHARED_RESUME_KEY) {
  await page.evaluateOnNewDocument((k, r) => {
    try { if (window.top === window && !sessionStorage.getItem(k)) sessionStorage.setItem(k, r); } catch { /* 存不了:页面留在开始页,探针等不到成员按钮 */ }
  }, storageKey, JSON.stringify(record));
}

/**
 * 在不整页刷新的前提下让已打开的在线编辑页切换到另一个共享项目(保留本页模块级状态,如 `measureGate` 的连接计数):
 * 先用 `newProject` 断开当前共享连接,再写入新项目的恢复记录并调用 `syncManager` 的 `resumeShared()`。
 */
export async function switchSharedInPlace(page, record, storageKey = SHARED_RESUME_KEY) {
  await page.evaluate(async (k, r) => {
    window.__pcStore?.actions?.newProject?.('未命名');
    sessionStorage.setItem(k, r);
    const resUrl = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/assets\/syncManager-.*\.js$/.test(n));
    const mod = await import(resUrl || '/src/editor/sync/syncManager.ts');
    const fn = mod.resumeShared || Object.values(mod).find((v) => typeof v === 'function' && /docProjectId.*candidate\.projectId/.test(String(v)));
    if (typeof fn !== 'function') throw new Error('找不到 resumeShared');
    await fn();
  }, storageKey, JSON.stringify(record));
}
