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

test("表 A 五条状态措辞与常驻提示一字不差", () => {
  assert.deepEqual({ ...st.ONLINE_STATUS_TEXT }, {
    noNetwork: "当前没有网络连接。",
    docDown: "连不上服务器，请稍后再试。你的修改先留在本页，恢复后会自动提交。",
    assetDown: "连不上素材服务，素材原尺寸和预渲染结果暂时显示不了。",
    recovering: "已恢复连接，正在提交离线时的修改…",
    recovered: "离线时的修改已全部提交。",
  });
  // 〔裁:2026-10-22 主会话〕按改动存没存下来分两句
  assert.deepEqual({ ...st.OFFLINE_UNSENT_TEXT }, {
    saved: "当前离线。你的改动已存在本机，连上网络后会合并回项目。",
    page: "当前离线。你的改动只在这个页面里，关掉页面就会丢失。",
  });
  assert.equal(st.offlineUnsentText("saved"), st.OFFLINE_UNSENT_TEXT.saved);
  assert.equal(st.offlineUnsentText("page"), st.OFFLINE_UNSENT_TEXT.page);
});

test("状态 → 措辞:断网、连不上文档服务、连不上素材服务、恢复中、恢复完成;暂停交给「同步已暂停」", () => {
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

test("离开编辑界面的确认:问的是「改动只在这个页面里」,不是「项目没保存」", () => {
  assert.equal(st.UNSENT_LEAVE_TEXT, "当前离线，你的改动只在这个页面里。离开编辑界面会丢失它们。继续？");
  // 手机版用自己的确认框(按钮「取消 / 离开」),正文一样、不带那一问
  assert.equal(st.UNSENT_LEAVE_TEXT, `${st.UNSENT_LEAVE_BODY}继续？`);
  assert.doesNotMatch(st.UNSENT_LEAVE_BODY, /继续/);
  // 在线页面都是云端项目,没有本机草稿(issue #16):这一句里不许再出现「未保存」那套说法
  assert.doesNotMatch(st.UNSENT_LEAVE_TEXT, /未保存|保存项目/);
  // 游客的项目不落盘(`offlineStore: "page"`):离线时攒的改动离开就没了,要问
  assert.equal(st.unsentAtRisk("offline", 1, "page"), true);
  assert.equal(st.unsentAtRisk("paused", 1, "page"), true);
  // 账号云端项目落盘到浏览器本地缓存:再进这个项目会接着提交,不问
  assert.equal(st.unsentAtRisk("offline", 3, "saved"), false);
  // 连着、或者手里没有没提交的:都不问
  assert.equal(st.unsentAtRisk("online", 3, "page"), false);
  assert.equal(st.unsentAtRisk("offline", 0, "page"), false);
});

test("存不住就说存不住:浏览器给不了存储时,离线改动算「只在这个页面里」", () => {
  // 退到内存版那一种:写进去不报错、关页面就没,不许说「已存在本机」
  assert.equal(st.offlineStoreOf({ durable: false, account: true, online: true }), "page");
  assert.equal(st.offlineStoreOf({ durable: false, account: true, online: false }), "page", "桌面版也一样");
  // 存得住的照旧:账号项目(含游客)落盘、桌面版有本机恢复文件 → 本机;在线页面的口令房间不落盘 → 本页
  assert.equal(st.offlineStoreOf({ durable: true, account: true, online: true }), "saved");
  assert.equal(st.offlineStoreOf({ durable: true, account: false, online: false }), "saved");
  assert.equal(st.offlineStoreOf({ durable: true, account: false, online: true }), "page");
  // 存不住那一句气泡:说的是「为什么」,不和常驻提示重样
  assert.equal(st.UNSENT_NO_STORE_TOAST, "这台浏览器存不下离线时的修改：它们只在这个页面里，关掉页面或离开编辑界面就会丢。");
  assert.notEqual(st.UNSENT_NO_STORE_TOAST, st.OFFLINE_UNSENT_TEXT.page);
});

test("缺省存储挑哪一种:IndexedDB → localStorage → 内存,内存那种报「存不住」", () => {
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
    assert.equal(oc.defaultStoreDurable(), true, "localStorage 关页面也还在,算存得住");

    oc.setDefaultStore(null);
    delete g.localStorage;
    assert.equal(oc.defaultStoreKind(), "memory");
    assert.equal(oc.defaultStoreDurable(), false, "内存版关页面就没,算存不住");
  } finally {
    oc.setDefaultStore(null);
    if (had.idb) g.indexedDB = had.idbV; else delete g.indexedDB;
    if (had.ls) g.localStorage = had.lsV; else delete g.localStorage;
  }
});

test("常驻提示:离线(含暂停)且有未提交的修改才挂", () => {
  assert.equal(st.offlineUnsent("offline", 2), true);
  assert.equal(st.offlineUnsent("paused", 1), false, "暂停时已连上,不说「当前离线」");
  assert.equal(st.unsentAtRisk("paused", 1), true, "暂停时关页面照样丢,挂离开确认");
  assert.equal(st.unsentAtRisk("offline", 1, "saved"), false, "改动已存在本机:关页面不丢,不拦");
  assert.equal(st.unsentAtRisk("offline", 1, "page"), true);
  assert.equal(st.unsentAtRisk("offline", 1), true);
  assert.equal(st.unsentAtRisk("online", 1), false);
  assert.equal(st.offlineUnsent("offline", 0), false);
  assert.equal(st.offlineUnsent("online", 3), false, "在线时未确认的提交正在飞,不算离线");
});

test("恢复阶段:离线攒过修改 → 回来还有没确认的 = 恢复中 → 确认完 = 恢复完成;离线没改过就不进", () => {
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
  assert.equal(d.phase, null, "丢弃之后不报恢复完成");
  // 刚回来就已经全确认了:直接恢复完成
  let r = { phase: null, wasOffline: false, hadUnsent: false };
  r = st.nextRecovery(r, "offline", 1);
  r = st.nextRecovery(r, "online", 0);
  assert.equal(r.phase, "recovered");
});

const overwritten = { kind: "overwritten", projectId: "p", entity: "/tracks/@t/clips/@c", by: { actor: { username: "bob" } }, rev: 7, value: { id: "c" }, at: Date.UTC(2026, 8, 27, 1, 2, 3) };
const discard = { kind: "offline-discard", projectId: "p", baseRev: 3, batch: [{ opId: "o1", ops: [] }, { opId: "o2", ops: [] }], project: { name: "x" }, at: Date.UTC(2026, 8, 27, 4, 5, 6) };

test("备份:只进内存、不自动下载,列表里逐个下载出 JSON(LocalBackup 原样)", () => {
  // 任何浏览器存储被碰到就炸
  const trap = new Proxy({}, { get() { throw new Error("不许碰浏览器存储"); } });
  const saved = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, indexedDB: globalThis.indexedDB };
  Object.defineProperty(globalThis, "localStorage", { value: trap, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: trap, configurable: true });
  Object.defineProperty(globalThis, "indexedDB", { value: trap, configurable: true });
  try {
    const downloads = [];
    const store = bk.createOnlineBackups({ download: (name, text) => downloads.push({ name, text }), projectName: () => "我的/项目" });
    let changes = 0;
    const off = store.subscribe(() => changes++);
    assert.equal(store.save(overwritten), 0);
    assert.equal(store.save(discard), 1);
    assert.equal(downloads.length, 0, "不自动下载");
    assert.equal(changes, 2);
    assert.equal(store.list().length, 2);
    assert.equal(store.download(1), true);
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].name, /^我的_项目-备份-离线丢弃-\d{8}-\d{6}-2\.json$/);
    const body = JSON.parse(downloads[0].text);
    assert.deepEqual(body.backup, discard);
    assert.equal(body.projectName, "我的/项目");
    assert.equal(store.download(0), true);
    assert.match(downloads[1].name, /-被覆盖-/);
    assert.deepEqual(JSON.parse(downloads[1].text).backup, overwritten);
    assert.equal(store.download(5), false, "没有这一份");
    off();
    store.save(overwritten);
    assert.equal(changes, 2, "退订之后不再回调");
  } finally {
    for (const [k, v] of Object.entries(saved)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});

test("备份:缺省的下载走 Blob + <a download> + click(浏览器里),不写存储", () => {
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

test("断网时导入媒体:只有在线浏览器置灰(浏览器说没网,或连不上文档服务);桌面版照常导入", () => {
  const of = (p) => st.importOfflineOf({ online: true, status: "online", active: true, navigatorOnline: true, ...p });
  assert.equal(st.IMPORT_OFFLINE_TEXT, "当前离线");
  assert.equal(of({}), false);
  assert.equal(of({ navigatorOnline: false }), true);
  assert.equal(of({ status: "offline" }), true);
  assert.equal(of({ status: "connecting" }), false, "刚进项目连接中不闪");
  assert.equal(of({ status: "offline", active: false }), false, "没进共享项目不判");
  assert.equal(of({ online: false, status: "offline", navigatorOnline: false }), false, "桌面版照常导入,连上后再上传");
});
