/**
 * 舞台这一侧的隔离:加固里的纯判定、自检的结论、执行闸门、舞台入口的认定(契约 `docs/plan/online-card-exec-contract.md` 第 3 节)。
 * 加固钩子与自检在真实浏览器里的行为由 `scripts/probes/online-card-security-probe.mjs` 断言。
 * 跑:node --test src/online/isolation/isolation.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FRAME_TAGS, htmlHasFrame, isFrameName, denyPersistentStorage, STAGE_STORAGE_PASSTHROUGH_KEY } from "./harden.ts";
import { judgeIsolation, criticalHardenErrors, ISOLATION_CHECK_BASE_PATH } from "./isolationCheck.ts";
import { cardExecGate, subscribeCardExecGate, markIsolatedStageDocument, setIsolationReport, noteMediaPolicy, noteBreach, resetExecGateForTest } from "./execGate.ts";
import { bootStageGuard, isStageEntryPath, announceStageIsolation, STAGE_ENTRY_FILE, resetStageGuardForTest } from "./stageGuard.ts";

const HARDENED = { installed: true, webrtcRemoved: false, trustedTypes: "unsupported", hooks: 38, errors: [] };
const OK_REPORT = judgeIsolation({ crossOrigin: true, csp: "header", allowlist: true, harden: HARDENED });

beforeEach(() => { resetExecGateForTest(); resetStageGuardForTest(); });

test("OCS-H-01 带子框架的 HTML 串:七种标签、大小写、带前缀、标签名前有空白都认;实体声明也拒;相近的名字不误伤", () => {
  for (const tag of FRAME_TAGS) {
    assert.ok(htmlHasFrame(`<${tag}>`), tag);
    assert.ok(htmlHasFrame(`<div><${tag.toUpperCase()} src="x"></div>`), tag);
    assert.ok(htmlHasFrame(`<x:${tag} xmlns:x="http://www.w3.org/1999/xhtml"/>`), tag);
    assert.ok(htmlHasFrame(`< ${tag}/>`), tag);
  }
  assert.ok(htmlHasFrame("<svg><foreignObject><iframe/></foreignObject></svg>"));
  assert.ok(htmlHasFrame('<!DOCTYPE r [<!ENTITY f "&#60;iframe/&#62;">]><r>&f;</r>'), "实体展开能在源文本里不出现标签名的情况下造出元素");
  assert.ok(htmlHasFrame("<!entity x 'y'>"));
  for (const fine of ["", "<div>iframe</div>", "<p>object embed frame</p>", "<svg><foreignObject><div/></foreignObject></svg>", "<frame-like-custom></frame-like-custom>",
    "<objectives>", "<embedded>", "<iframes>", "<my-iframe>", "&lt;iframe&gt;", "<div data-x=\"<b>\">", null, undefined, 42]) {
    assert.equal(htmlHasFrame(fine), false, String(fine));
  }
});

test("OCS-H-02 元素名是不是子框架类:大小写、前缀、首尾空白都认;别的不认", () => {
  for (const name of ["iframe", "IFRAME", "iFrAmE", "html:iframe", "x:OBJECT", "embed", "frame", "frameset", "portal", "fencedframe", " iframe "]) assert.ok(isFrameName(name), name);
  for (const name of ["div", "foreignObject", "my-iframe", "iframes", "object-fit", "", null, undefined, "video"]) assert.equal(isFrameName(name), false, String(name));
});

test("OCS-H-03 无出口白名单/Trusted Types/WebRTC guard仍通过，分源和响应头策略不可缺", () => {
  assert.deepEqual(OK_REPORT,{ok:true,crossOrigin:true,csp:'header',egress:'none',hardened:true,trustedTypes:'unsupported',reasons:[]});
  for(const trustedTypes of ['unsupported','created','failed','enforced']) assert.equal(judgeIsolation({crossOrigin:true,csp:'header',allowlist:false,harden:{...HARDENED,webrtcRemoved:false,trustedTypes}}).ok,true);
  const cases=[
    [{crossOrigin:false,csp:'header',harden:HARDENED},['same-origin']],
    [{crossOrigin:true,csp:'none',harden:HARDENED},['no-policy']],
    [{crossOrigin:true,csp:'meta',harden:HARDENED},['meta-only']],
    [{crossOrigin:true,csp:'header',harden:null},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,installed:false}},['not-hardened']],
    // 关键项没装上(审查 P3):装了也不算
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['storage:localStorage:Cannot redefine property']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['storage:sessionStorage:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['storage:indexedDB:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['storage:caches:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:Worker:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:BroadcastChannel:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:SharedWorker:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:indexedDB:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:locks:x']}},['not-hardened']],
    [{crossOrigin:true,csp:'header',harden:{...HARDENED,errors:['scope:integrity:内置对象或平台接口在守卫之前被改过(JSON)']}},['not-hardened']],
  ];
  for(const [facts,reasons] of cases){const r=judgeIsolation(facts);assert.equal(r.ok,false);assert.deepEqual(r.reasons,reasons);}
  // 非关键项(纵深防御那几层、旧式文件系统入口等)没装上不挡执行;名字只是前缀相近的也不算
  for (const e of ['storage:webkitRequestFileSystem:x', 'scope:IDBFactory.open:x', 'window:name:x', 'MutationObserver:x', 'storage:localStorageX:x', 'scope:WorkerX:x']) {
    assert.equal(judgeIsolation({crossOrigin:true,csp:'header',harden:{...HARDENED,errors:[e]}}).ok, true, e);
  }
  assert.deepEqual(criticalHardenErrors(['scope:Worker:a', 'x', 'storage:caches:b']), ['scope:Worker:a', 'storage:caches:b']);
  assert.deepEqual(criticalHardenErrors(undefined), []);
  assert.ok(ISOLATION_CHECK_BASE_PATH.startsWith('/'));
});

test("OCS-H-04 执行闸门:不是舞台文档、自检没出结果、自检没过、父页没点头,都不执行;四样齐了才开", () => {
  assert.deepEqual({ allowed: cardExecGate().allowed, reason: cardExecGate().reason }, { allowed: false, reason: "not-stage" });
  // 不是舞台文档:父页怎么点头都不开
  noteMediaPolicy({ cardExec: true });
  assert.equal(cardExecGate().reason, "not-stage");
  markIsolatedStageDocument();
  assert.equal(cardExecGate().reason, "checking");
  setIsolationReport(judgeIsolation({ crossOrigin: true, csp: "meta", allowlist: false, harden: HARDENED }));
  assert.equal(cardExecGate().reason, "not-isolated");
  setIsolationReport(OK_REPORT);
  assert.equal(cardExecGate().reason, "ok");
  assert.equal(cardExecGate().allowed, true);
  // 父页收回(另一台没过、总开关关了):关上;再点头再开
  noteMediaPolicy({ cardExec: false });
  assert.deepEqual({ allowed: cardExecGate().allowed, reason: cardExecGate().reason }, { allowed: false, reason: "parent" });
  noteMediaPolicy(null);
  assert.equal(cardExecGate().reason, "parent");
  noteMediaPolicy({ cardExec: true, ticket: null });
  assert.equal(cardExecGate().allowed, true);
});

test("OCS-H-05 执行闸门·要执行就不放秘密:见过票据的文档永久不执行;开过闸门的文档不再收票据", () => {
  markIsolatedStageDocument();
  setIsolationReport(OK_REPORT);
  // 旧办法:父页给了带票据的取档策略 → 这份票据可以用,但本文档永久不执行(哪怕父页同时点头)
  assert.deepEqual(noteMediaPolicy({ ticket: "v1.aaa.bbb", cardExec: true }), { acceptTicket: true });
  assert.equal(cardExecGate().reason, "ticket-seen");
  noteMediaPolicy({ cardExec: true, ticket: null });
  assert.equal(cardExecGate().reason, "ticket-seen", "之后不带票据再点头也不开");
  assert.equal(cardExecGate().allowed, false);

  resetExecGateForTest();
  markIsolatedStageDocument();
  setIsolationReport(OK_REPORT);
  noteMediaPolicy({ cardExec: true });
  assert.equal(cardExecGate().allowed, true);
  // 闸门开过(可能跑过用户代码)之后再来的票据:不收,调用方把它丢掉
  assert.deepEqual(noteMediaPolicy({ ticket: "v1.aaa.bbb" }), { acceptTicket: false });
  assert.equal(cardExecGate().allowed, false);
  assert.equal(cardExecGate().reason, "parent");
  // 没票据的策略:acceptTicket 为假(没有票据可收)
  assert.deepEqual(noteMediaPolicy({ ticket: "", cardExec: true }), { acceptTicket: false });
});

test("OCS-H-06 执行闸门·加固拦下过造子框架的代码:永久关上;状态变了通知订阅方、没变不通知", () => {
  markIsolatedStageDocument();
  setIsolationReport(OK_REPORT);
  let calls = 0;
  const off = subscribeCardExecGate(() => { calls++; });
  noteMediaPolicy({ cardExec: true });
  assert.equal(calls, 1);
  const same = cardExecGate();
  noteMediaPolicy({ cardExec: true });
  assert.equal(calls, 1);
  assert.equal(cardExecGate(), same, "状态没变时对象身份不变");
  noteBreach();
  assert.equal(calls, 2);
  assert.deepEqual({ allowed: cardExecGate().allowed, reason: cardExecGate().reason }, { allowed: false, reason: "breach" });
  noteMediaPolicy({ cardExec: true });
  setIsolationReport(OK_REPORT);
  assert.equal(cardExecGate().reason, "breach");
  off();
  noteMediaPolicy({ cardExec: false });
  assert.equal(calls, 2);
});

test("OCS-H-07 舞台入口按路径认:只有 stage.html;编辑器页、同源单舞台(/editor/?stage=1)、导出页都不是", () => {
  assert.equal(STAGE_ENTRY_FILE, "stage.html");
  for (const p of ["/editor/stage.html", "/stage.html", "/a/b/stage.html"]) assert.ok(isStageEntryPath(p), p);
  for (const p of ["/editor", "/editor/", "/editor/index.html", "/editor/stage.html/", "/editor/xstage.html", "/editor/stage.htm", "", "/"]) assert.equal(isStageEntryPath(p), false, p);
});

test("OCS-H-08 启动钩子:不是在线构建、不在浏览器里、不是舞台入口都不做事(不装加固、闸门留在 not-stage、不向父页发消息)", () => {
  // Node 里没有 window:任何组合都不做事
  assert.equal(bootStageGuard({ online: true, base: "/editor/" }), false);
  assert.equal(bootStageGuard({ online: false, base: "/editor/" }), false);
  assert.equal(cardExecGate().reason, "not-stage");
  assert.doesNotThrow(() => announceStageIsolation());
  // 有 window 但路径不是舞台入口(编辑器页、同源单舞台):同样不做事,只留一个只读的观察口
  const posted = [];
  const fakeWindow = { parent: { postMessage: (m) => posted.push(m) } };
  globalThis.window = fakeWindow;
  globalThis.location = { pathname: "/editor/" };
  try {
    assert.equal(bootStageGuard({ online: true, base: "/editor/" }), false);
    assert.equal(cardExecGate().reason, "not-stage");
    assert.deepEqual(fakeWindow.__pcCardExecGate(), { allowed: false, reason: "not-stage" });
    assert.equal(fakeWindow.__pcStageIsolation, undefined);
    announceStageIsolation();
    assert.equal(posted.length, 0);
    // 桌面运行环境(不是在线构建)连观察口都不留
    delete fakeWindow.__pcCardExecGate;
    globalThis.location = { pathname: "/editor/stage.html" };
    assert.equal(bootStageGuard({ online: false, base: "/" }), false);
    assert.equal(fakeWindow.__pcCardExecGate, undefined);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

/** 仿浏览器的全局对象:存储入口挂在实例或原型上(窗口在实例上,Worker 的 indexedDB / caches 在原型上),全是可改的访问器 */
function fakeGlobal({ onProto = false } = {}) {
  const realLocal = new Map(), realSession = new Map();
  const storageOf = (m) => ({
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  });
  const proto = {};
  const scope = Object.create(proto);
  const host = onProto ? proto : scope;
  const accessor = (o, k, v) => Object.defineProperty(o, k, { configurable: true, enumerable: true, get: () => v });
  accessor(scope, "localStorage", storageOf(realLocal));
  accessor(scope, "sessionStorage", storageOf(realSession));
  const idb = { open: () => ({}) };
  accessor(host, "indexedDB", idb);
  accessor(host, "caches", { open: async () => ({}) });
  Object.defineProperty(scope, "webkitRequestFileSystem", { configurable: true, writable: true, value: () => {} });
  class StorageManager { async getDirectory() { return "opfs-root"; } async estimate() { return {}; } }
  class StorageBucketManager { async open() { return "bucket"; } }
  scope.StorageManager = StorageManager;
  scope.StorageBucketManager = StorageBucketManager;
  scope.navigator = { storage: new StorageManager(), storageBuckets: new StorageBucketManager() };
  return { scope, proto, realLocal, realSession, idb };
}

test("OCS-H-09 舞台源的持久存储收走:卡片写的 localStorage / sessionStorage 只留在本文档内存;IndexedDB、Cache Storage、旧文件系统、源私有文件系统、存储桶都用不了,也改不回来", async () => {
  const { scope, realLocal, realSession } = fakeGlobal();
  realLocal.set("old-key", "old-value");
  const r = denyPersistentStorage(scope);
  assert.deepEqual(r.errors, []);
  for (const k of ["localStorage", "sessionStorage", "indexedDB", "caches", "webkitRequestFileSystem", "StorageManager.getDirectory", "StorageBucketManager.open"]) assert.ok(r.denied.includes(k), k);

  // 「卡片」把参数里的素材地址(带路径号)存下来:本文档里读得回,真实存储里没有
  const leak = "/media-s/0123456789abcdef0123456789abcdef/media/" + "a".repeat(64);
  scope.localStorage.setItem("params", leak);
  scope.sessionStorage.setItem("params", leak);
  scope.localStorage.leakProp = leak; // 属性写法同样只在内存
  assert.equal(scope.localStorage.leakProp, leak);
  assert.equal(realLocal.has("leakProp"), false);
  assert.equal(scope.localStorage.getItem("params"), leak);
  assert.equal(scope.sessionStorage.getItem("params"), leak);
  assert.equal(realLocal.has("params"), false);
  assert.equal(realSession.has("params"), false);
  // 真实存储里原有的键列不出、读不到、删不掉
  assert.equal(scope.localStorage.getItem("old-key"), null);
  assert.equal(scope.localStorage.length, 1);
  assert.deepEqual([0, 1].map((i) => scope.localStorage.key(i)), ["params", null]);
  scope.localStorage.removeItem("old-key"); scope.localStorage.clear();
  assert.equal(realLocal.get("old-key"), "old-value");

  // 唯一放行的:取档的「能不能放」结论,键形状与值都要对
  const hash = "b".repeat(64);
  assert.ok(STAGE_STORAGE_PASSTHROUGH_KEY.test(`pc.playable.152:${hash}`));
  scope.localStorage.setItem(`pc.playable.152:${hash}`, "1");
  assert.equal(realLocal.get(`pc.playable.152:${hash}`), "1");
  assert.equal(scope.localStorage.getItem(`pc.playable.152:${hash}`), "1");
  scope.localStorage.setItem(`pc.playable.152:${"c".repeat(64)}`, leak); // 值不对:不写真实存储,也不留内存
  assert.equal(realLocal.has(`pc.playable.152:${"c".repeat(64)}`), false);
  assert.equal(scope.localStorage.getItem(`pc.playable.152:${"c".repeat(64)}`), null);
  for (const bad of [`pc.playable.152:${hash}x`, `pc.playable.x:${hash}`, `pc.playable.152:${"B".repeat(64)}`, `pc.stageSid.v1:a:b`, `xpc.playable.152:${hash}`]) {
    scope.localStorage.setItem(bad, "1");
    assert.equal(realLocal.has(bad), false, bad);
  }
  realLocal.set(`pc.playable.152:${"d".repeat(64)}`, leak); // 真实存储里形状不对的值读出来也当没有
  assert.equal(scope.localStorage.getItem(`pc.playable.152:${"d".repeat(64)}`), null);
  // 放行的键不能删掉真实存储里的结论
  scope.localStorage.removeItem(`pc.playable.152:${hash}`);
  assert.equal(realLocal.get(`pc.playable.152:${hash}`), "1");

  assert.equal(scope.indexedDB, undefined);
  assert.equal(scope.caches, undefined);
  assert.equal(scope.webkitRequestFileSystem, undefined);
  await assert.rejects(scope.navigator.storage.getDirectory(), /持久存储/);
  await assert.rejects(scope.navigator.storageBuckets.open("x"), /持久存储/);
  assert.deepEqual(await scope.navigator.storage.estimate(), {}, "不相干的方法照旧");

  // 卡片代码想改回来:重新定义、赋值、删除都不成
  for (const k of ["localStorage", "sessionStorage", "indexedDB", "caches"]) {
    assert.throws(() => Object.defineProperty(scope, k, { value: {} }), TypeError, k);
    assert.equal(Reflect.set(scope, k, {}), false, k);
    assert.equal(Reflect.deleteProperty(scope, k), false, k);
  }
  assert.throws(() => Object.defineProperty(scope.StorageManager.prototype, "getDirectory", { value: async () => "x" }), TypeError);
  assert.throws(() => { scope.localStorage.getItem = () => leak; }, TypeError, "内存那一份的方法锁死");
  assert.throws(() => Object.defineProperty(scope.localStorage, "setItem", { value: () => {} }), TypeError);
});

test("OCS-H-10 Worker 的全局对象(入口在原型上)同样收走,原型上的原访问器拿不回来;声音线程与舞台加固都调用它", () => {
  const { scope, proto, idb } = fakeGlobal({ onProto: true });
  denyPersistentStorage(scope);
  assert.equal(scope.indexedDB, undefined);
  assert.equal(scope.caches, undefined);
  const d = Object.getOwnPropertyDescriptor(proto, "indexedDB");
  assert.equal(d.get, undefined, "原型上的访问器换成了值");
  assert.equal(d.value, undefined);
  assert.notEqual(scope.indexedDB, idb);
  // 接线:舞台加固与声音线程都调它(源码核对;真实浏览器里的行为由 media-cache-probe 核)
  const harden = fs.readFileSync(new URL("./harden.ts", import.meta.url), "utf8");
  assert.match(harden, /const storage = denyPersistentStorage\(w\);/);
  const worker = fs.readFileSync(new URL("../cardRuntime/soundWorker.ts", import.meta.url), "utf8");
  const call = worker.indexOf("denyPersistentStorage(self);");
  assert.ok(call > 0 && call < worker.indexOf("createSoundThread({"), "声音线程在建线程(载入卡片代码)之前收走存储");
});
