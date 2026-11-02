/**
 * 在线页面的离线提示与本地备份(C10 契约第 10 节、第 17 节表 A、第 18 节第 4 条)的纯逻辑单测。跑:
 *   node --test src/editor/sync/onlineSync.test.mjs
 *
 * - `onlineStatus.ts`:表 A 五条措辞一字不差;状态 → 措辞;常驻提示与离开那一问的条件;离线改动存在哪;恢复阶段的状态机;
 * - `offlineCache.ts`:缺省存储挑哪一种、存不存得住(退到内存版时关页面就没,界面要说实话);
 * - `onlineBackups.ts`:只进内存(不碰任何浏览器存储)、不自动下载、逐个下载出 JSON。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const st = await import(srcUrl("editor/sync/onlineStatus.ts"));
const bk = await import(srcUrl("editor/sync/onlineBackups.ts"));
const oc = await import(srcUrl("editor/sync/offlineCache.ts"));

test("The five status wordings in table A match the persistent notice word for word", () => {
  assert.deepEqual({ ...st.ONLINE_STATUS_TEXT }, {
    noNetwork: "No network connection at the moment.",
    docDown: "Can't connect to the server, please try again later. Your changes stay on this page for now and will be submitted automatically once the connection is restored.",
    assetDown: "Can't connect to the asset service, so original-size media and prerender output can't be displayed for now.",
    recovering: "Connection restored. Submitting the changes made while offline…",
    recovered: "All changes made while offline have been submitted.",
  });
  // 〔裁:2026-10-22 主会话〕按改动存没存下来分两句
  assert.deepEqual({ ...st.OFFLINE_UNSENT_TEXT }, {
    saved: "Currently offline. Your changes are saved on this machine and will be merged back into the project once you're back online.",
    page: "Currently offline. Your changes exist only on this page and will be lost when you close it.",
  });
  assert.equal(st.offlineUnsentText("saved"), st.OFFLINE_UNSENT_TEXT.saved);
  assert.equal(st.offlineUnsentText("page"), st.OFFLINE_UNSENT_TEXT.page);
});

test("status → wording: no network, cannot reach the document service, cannot reach the asset service, recovering, recovery complete; paused is left to \"Sync paused\"", () => {
  const base = { status: "online", navigatorOnline: true, assetDown: false, recovery: null };
  const of = (p) => st.onlineStatusOf({ ...base, ...p });
  assert.equal(of({}), null);
  assert.equal(of({ status: "offline", navigatorOnline: false }), "noNetwork");
  assert.equal(of({ status: "offline" }), "docDown");
  assert.equal(of({ assetDown: true }), "assetDown");
  assert.equal(of({ assetDown: true, navigatorOnline: false }), "noNetwork");
  assert.equal(of({ recovery: "recovering" }), "recovering");
  assert.equal(of({ recovery: "recovered" }), "recovered");
  assert.equal(of({ status: "paused" }), null);
  assert.equal(of({ status: "connecting", recovery: "recovering" }), "recovering");
});

test("confirmation when leaving the editor: it says \"changes exist only in this page\", not \"project not saved\"", () => {
  assert.equal(st.UNSENT_LEAVE_TEXT, "You are offline, and your changes exist only in this page. Leaving the editor will lose them. Continue?");
  // 手机版用自己的确认框(按钮「取消 / 离开」),正文一样、不带那一问
  assert.equal(st.UNSENT_LEAVE_TEXT, `${st.UNSENT_LEAVE_BODY} Continue?`);
  assert.doesNotMatch(st.UNSENT_LEAVE_BODY, /Continue/);
  // 在线页面都是云端项目,没有本机草稿(issue #16):这一句里不许再出现「未保存」那套说法
  assert.doesNotMatch(st.UNSENT_LEAVE_TEXT, /unsaved|save the project/);
  // 游客的项目不落盘(`offlineStore: "page"`):离线时攒的改动离开就没了,要问
  assert.equal(st.unsentAtRisk("offline", 1, "page"), true);
  assert.equal(st.unsentAtRisk("paused", 1, "page"), true);
  // 账号云端项目落盘到浏览器本地缓存:再进这个项目会接着提交,不问
  assert.equal(st.unsentAtRisk("offline", 3, "saved"), false);
  // 连着、或者手里没有没提交的:都不问
  assert.equal(st.unsentAtRisk("online", 3, "page"), false);
  assert.equal(st.unsentAtRisk("offline", 0, "page"), false);
});

test("if it can't persist, say so: when the browser cannot provide storage, offline changes count as \"only in this page\"", () => {
  // 退到内存版那一种:写进去不报错、关页面就没,不许说「已存在本机」
  assert.equal(st.offlineStoreOf({ durable: false, account: true, online: true }), "page");
  assert.equal(st.offlineStoreOf({ durable: false, account: true, online: false }), "page", "same for the desktop app");
  // 存得住的照旧:账号项目(含游客)落盘、桌面版有本机恢复文件 → 本机;在线页面的口令房间不落盘 → 本页
  assert.equal(st.offlineStoreOf({ durable: true, account: true, online: true }), "saved");
  assert.equal(st.offlineStoreOf({ durable: true, account: false, online: false }), "saved");
  assert.equal(st.offlineStoreOf({ durable: true, account: false, online: true }), "page");
  // 存不住那一句气泡:说的是「为什么」,不和常驻提示重样
  assert.equal(st.UNSENT_NO_STORE_TOAST, "This browser can't store changes made offline: they exist only in this page and will be lost if you close the page or leave the editor.");
  assert.notEqual(st.UNSENT_NO_STORE_TOAST, st.OFFLINE_UNSENT_TEXT.page);
});

test("which default store is picked: IndexedDB → localStorage → memory, and the memory one reports \"cannot persist\"", () => {
  const g = globalThis;
  const had = { idb: "indexedDB" in g, ls: "localStorage" in g, idbV: g.indexedDB, lsV: g.localStorage };
  const fakeIdb = { open: () => ({}) };
  const fakeLs = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  try {
    oc.setDefaultStore(null);
    g.indexedDB = fakeIdb; g.localStorage = fakeLs;
    assert.equal(oc.defaultStoreKind(), "idb");
    assert.equal(oc.defaultStoreDurable(), true);

    oc.setDefaultStore(null);
    delete g.indexedDB;
    assert.equal(oc.defaultStoreKind(), "local");
    assert.equal(oc.defaultStoreDurable(), true, "localStorage survives closing the page, so it counts as persistent");

    oc.setDefaultStore(null);
    delete g.localStorage;
    assert.equal(oc.defaultStoreKind(), "memory");
    assert.equal(oc.defaultStoreDurable(), false, "the in-memory version is gone when the page closes, so it counts as not persistent");
  } finally {
    oc.setDefaultStore(null);
    if (had.idb) g.indexedDB = had.idbV; else delete g.indexedDB;
    if (had.ls) g.localStorage = had.lsV; else delete g.localStorage;
  }
});

test("persistent notice: shown only when offline (including paused) and there are uncommitted changes", () => {
  assert.equal(st.offlineUnsent("offline", 2), true);
  assert.equal(st.offlineUnsent("paused", 1), false, "when paused it is still connected, so it doesn't say \"currently offline\"");
  assert.equal(st.unsentAtRisk("paused", 1), true, "when paused, closing the page still loses changes, so the leave confirmation is attached");
  assert.equal(st.unsentAtRisk("offline", 1, "saved"), false, "changes are already saved locally: closing the page loses nothing, so no blocking");
  assert.equal(st.unsentAtRisk("offline", 1, "page"), true);
  assert.equal(st.unsentAtRisk("offline", 1), true);
  assert.equal(st.unsentAtRisk("online", 1), false);
  assert.equal(st.offlineUnsent("offline", 0), false);
  assert.equal(st.offlineUnsent("online", 3), false, "while online, unconfirmed commits in flight do not count as offline");
});

test("recovery phase: changes accumulated offline → still unconfirmed after coming back = recovering → all confirmed = recovery complete; not entered if nothing was changed offline", () => {
  let s = { phase: null, wasOffline: false, hadUnsent: false };
  s = st.nextRecovery(s, "online", 0);
  assert.equal(s.phase, null);
  s = st.nextRecovery(s, "offline", 0);
  s = st.nextRecovery(s, "offline", 2);
  assert.equal(s.phase, null);
  s = st.nextRecovery(s, "connecting", 2);
  assert.equal(s.phase, "recovering");
  s = st.nextRecovery(s, "online", 1);
  assert.equal(s.phase, "recovering");
  s = st.nextRecovery(s, "online", 0);
  assert.equal(s.phase, "recovered");
  // 离线期间什么都没改:回来不提示
  let q = { phase: null, wasOffline: false, hadUnsent: false };
  q = st.nextRecovery(q, "offline", 0);
  q = st.nextRecovery(q, "online", 0);
  assert.equal(q.phase, null);
  // 回来后第一条被拒 → 暂停 → 丢弃:不说「已全部提交」
  let d = { phase: null, wasOffline: false, hadUnsent: false };
  d = st.nextRecovery(d, "offline", 2);
  d = st.nextRecovery(d, "connecting", 2);
  assert.equal(d.phase, "recovering");
  d = st.nextRecovery(d, "paused", 2);
  assert.equal(d.phase, null);
  d = st.nextRecovery(d, "online", 0);
  assert.equal(d.phase, null, "after discarding, recovery complete is not reported");
  // 刚回来就已经全确认了:直接恢复完成
  let r = { phase: null, wasOffline: false, hadUnsent: false };
  r = st.nextRecovery(r, "offline", 1);
  r = st.nextRecovery(r, "online", 0);
  assert.equal(r.phase, "recovered");
});

const overwritten = { kind: "overwritten", projectId: "p", entity: "/tracks/@t/clips/@c", by: { actor: { username: "bob" } }, rev: 7, value: { id: "c" }, at: Date.UTC(2026, 8, 27, 1, 2, 3) };
const discard = { kind: "offline-discard", projectId: "p", baseRev: 3, batch: [{ opId: "o1", ops: [] }, { opId: "o2", ops: [] }], project: { name: "x" }, at: Date.UTC(2026, 8, 27, 4, 5, 6) };

test("backups: kept in memory only and not downloaded automatically, downloaded one by one from the list as JSON (LocalBackup as is)", () => {
  // 任何浏览器存储被碰到就炸
  const trap = new Proxy({}, { get() { throw new Error("must not touch browser storage"); } });
  const saved = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, indexedDB: globalThis.indexedDB };
  Object.defineProperty(globalThis, "localStorage", { value: trap, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: trap, configurable: true });
  Object.defineProperty(globalThis, "indexedDB", { value: trap, configurable: true });
  try {
    const downloads = [];
    const store = bk.createOnlineBackups({ download: (name, text) => downloads.push({ name, text }), projectName: () => "My/project" });
    let changes = 0;
    const off = store.subscribe(() => changes++);
    assert.equal(store.save(overwritten), 0);
    assert.equal(store.save(discard), 1);
    assert.equal(downloads.length, 0, "not downloaded automatically");
    assert.equal(changes, 2);
    assert.equal(store.list().length, 2);
    assert.equal(store.download(1), true);
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].name, /^我的_项目-backup-discarded offline-\d{8}-\d{6}-2\.json$/);
    const body = JSON.parse(downloads[0].text);
    assert.deepEqual(body.backup, discard);
    assert.equal(body.projectName, "My/project");
    assert.equal(store.download(0), true);
    assert.match(downloads[1].name, /-overwritten-/);
    assert.deepEqual(JSON.parse(downloads[1].text).backup, overwritten);
    assert.equal(store.download(5), false, "no such backup");
    off();
    store.save(overwritten);
    assert.equal(changes, 2, "no more callbacks after unsubscribing");
  } finally {
    for (const [k, v] of Object.entries(saved)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});

test("backups: the default download goes through Blob + <a download> + click (in the browser) and does not write to storage", () => {
  const clicks = [];
  const saved = { document: globalThis.document, URL: globalThis.URL };
  const a = { style: {}, click() { clicks.push({ href: this.href, download: this.download }); }, remove() {} };
  globalThis.document = { createElement: (tag) => { assert.equal(tag, "a"); return a; }, body: { appendChild() {} } };
  const created = [];
  globalThis.URL = class extends saved.URL {};
  globalThis.URL.createObjectURL = (blob) => { created.push(blob); return "blob:x"; };
  globalThis.URL.revokeObjectURL = () => {};
  try {
    const store = bk.createOnlineBackups();
    store.save(overwritten);
    assert.equal(clicks.length, 0);
    store.download(0);
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].href, "blob:x");
    assert.match(clicks[0].download, /\.json$/);
    assert.equal(created[0].type, "application/json;charset=utf-8");
  } finally {
    globalThis.document = saved.document;
    globalThis.URL = saved.URL;
  }
});

test("importing media while offline: only the online browser greys it out (the browser reports no network, or the document service cannot be reached); the desktop app imports as usual", () => {
  const of = (p) => st.importOfflineOf({ online: true, status: "online", active: true, navigatorOnline: true, ...p });
  assert.equal(st.IMPORT_OFFLINE_TEXT, "You are offline");
  assert.equal(of({}), false);
  assert.equal(of({ navigatorOnline: false }), true);
  assert.equal(of({ status: "offline" }), true);
  assert.equal(of({ status: "connecting" }), false, "no flicker while connecting right after entering a project");
  assert.equal(of({ status: "offline", active: false }), false, "not judged when not in a shared project");
  assert.equal(of({ online: false, status: "offline", navigatorOnline: false }), false, "the desktop app imports as usual and uploads after connecting");
});
