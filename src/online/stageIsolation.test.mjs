/**
 * 编辑器页这一侧的舞台隔离会话:自检结果的校验、每台舞台取素材走哪条路、本页能不能执行用户卡与素材效果卡、票据交接(契约
 * `docs/plan/online-card-exec-contract.md` 第 3.1、3.2、4.1 节)。
 * 跑:node --test src/online/stageIsolation.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_SANDBOX, STAGE_SID_STORAGE_PREFIX, createStageSidStore, createStageIsolation, sanitizeIsolationReport, sanitizeBreach, newSid, grantMediaCookie,
  onlineCardExec, subscribeOnlineCardExec, pageStageIsolation, resetPageStageIsolationForTest,
} from "./stageIsolation.ts";

const OK = { ok: true, crossOrigin: true, csp: "header", egress: "none", hardened: true, trustedTypes: "unsupported", reasons: [] };
const BAD = { ok: false, crossOrigin: true, csp: "meta", egress: "script", hardened: true, trustedTypes: "enforced", reasons: ["meta-only"] };
const SID = "0123456789abcdef0123456789abcdef";
const TICKET = "v1.payload-payload-payload.signature-signature";
const S1 = "https://s1.x.io", S2 = "https://s2.x.io";

/** 一份会话:总开关、交接都可控;定时器收在数组里手动触发 */
function make({ enabled = true, grantOk = true } = {}) {
  const state = { enabled, grantOk, grants: [], timers: [] };
  const iso = createStageIsolation({
    enabled: () => state.enabled,
    grant: async (origin, sid, ticket) => { state.grants.push({ origin, sid, ticket }); return state.grantOk; },
    sid: SID,
    setTimer: (fn) => { state.timers.push(fn); return state.timers.length; },
    clearTimer: () => {},
  });
  return { iso, state };
}
/** 两台都握手、自检通过、交接成功 */
async function bothIsolated(iso) {
  iso.setStages(["A", "B"]);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", OK);
  const a = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  const b = await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  return { a, b };
}

test("OCS-S-01 舞台 iframe 的 sandbox 只开脚本与保有自己的源两项", () => {
  assert.equal(STAGE_SANDBOX, "allow-scripts allow-same-origin");
  for (const no of ["allow-popups", "allow-top-navigation", "allow-forms", "allow-modals", "allow-downloads"]) assert.ok(!STAGE_SANDBOX.includes(no), no);
});

test("OCS-S-02 舞台发来的自检结果按形状校验,结论不信舞台自己下的、按各项事实重算", () => {
  assert.deepEqual(sanitizeIsolationReport(OK), OK);
  // 舞台自称通过,但事实不齐:重算成不通过
  for (const lie of [{ ...OK, csp: "meta" }, { ...OK, csp: "none" }, { ...OK, crossOrigin: false }, { ...OK, hardened: false }, { ...OK, reasons: ["meta-only"] }]) {
    assert.equal(sanitizeIsolationReport(lie).ok, false, JSON.stringify(lie));
  }
  // 多出来的字段丢掉;认不出的原因丢掉
  const extra = sanitizeIsolationReport({ ...BAD, ticket: "x", reasons: ["meta-only", "made-up", 42] });
  assert.deepEqual(extra, BAD);
  for (const bad of [null, undefined, 42, "ok", [], {}, { ok: true }, { ...OK, csp: "response" }, { ...OK, egress: "browser" }, { ...OK, trustedTypes: "yes" }, { ...OK, ok: "true" }, { ...OK, reasons: "none" }, { ...OK, hardened: 1 }]) {
    assert.equal(sanitizeIsolationReport(bad), null, JSON.stringify(bad));
  }
  assert.equal(sanitizeBreach("create"), "create");
  for (const bad of ["", "nope", null, 1, {}]) assert.equal(sanitizeBreach(bad), null);
});

test("OCS-S-03 两台都自检通过、票据交接成功:都走 cookie(基址 /media-s/<sid>、不带票据),本页判可执行", async () => {
  const { iso, state } = make();
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "no-stage" });
  const { a, b } = await bothIsolated(iso);
  assert.deepEqual(a, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false }, "另一台还没好:先不点头");
  assert.deepEqual(b, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: true });
  assert.deepEqual(iso.state(), { enabled: true, reason: "ok", detail: {}, egress: "none" });
  assert.deepEqual(state.grants, [{ origin: S1, sid: SID, ticket: TICKET }, { origin: S2, sid: SID, ticket: TICKET }]);
  // 同一张票据不重复交接;这回两台都点头
  const again = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(again.cardExec, true);
  assert.equal(state.grants.length, 2);
  // 取档策略连着算几遍(还没交接完又来一次):同一张票据只发一次请求
  {
    const m2 = make();
    m2.iso.setStages(["A", "B"]); m2.iso.handshake("A"); m2.iso.report("A", OK);
    const both = await Promise.all([1, 2, 3].map(() => m2.iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET })));
    assert.equal(m2.state.grants.length, 1);
    assert.ok(both.every((p) => p.mode === "cookie" && p.ticket === null));
  }
  // 续票:换了一张就再交接一次
  await iso.plan("A", { active: true, stageOrigin: S1, ticket: `${TICKET}2` });
  assert.equal(state.grants.length, 3);
  assert.equal(iso.sid, SID);
});

test("OCS-S-04 浏览器没有出口白名单或Trusted Types:分源和交接就绪仍可执行", async () => {
  const { iso } = make();
  iso.setStages(["A", "B"]);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", { ...OK, egress: "none" });
  await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.deepEqual({ enabled: iso.state().enabled, egress: iso.state().egress }, { enabled: true, egress: "none" });
});

test("OCS-S-05 托管方关了总开关:不交接、不等自检,两台都不给票据(严禁退回带票据的旧办法),原因是总开关;打开后恢复", async () => {
  const { iso, state } = make({ enabled: false });
  const { a, b } = await bothIsolated(iso);
  for (const p of [a, b]) assert.deepEqual(p, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  assert.equal(state.grants.length, 0);
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "switch-off" });
});

test("OCS-S-06 有一台自检没过(只有 <meta> 兜底):那一台不给票据,本页不执行,说得出是哪台、为什么", async () => {
  const { iso, state } = make();
  iso.setStages(["A", "B"]);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", BAD);
  const a = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  const b = await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.equal(a.mode, "cookie");
  assert.equal(a.cardExec, false);
  assert.deepEqual(b, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  assert.deepEqual(iso.state(), { enabled: false, reason: "not-isolated", detail: { B: ["meta-only"] }, egress: null });
  assert.deepEqual(state.grants.map((g) => g.origin), [S1], "没过的那一台不交接");
});

test("OCS-S-07 票据交接没成(舞台源没有 /media-s/、第三方 cookie 被拦):不给票据,本页不执行,原因是交接", async () => {
  const { iso } = make({ grantOk: false });
  const { a } = await bothIsolated(iso);
  assert.deepEqual(a, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "grant-failed" });
});

test("OCS-S-08 握手之后等不到自检结果(旧版舞台页不发、舞台卡住):到时按自检出错,不给票据", async () => {
  const { iso, state } = make();
  iso.setStages(["A", "B"]);
  iso.handshake("A");
  const pending = iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  await Promise.resolve();
  assert.equal(state.timers.length, 1);
  state.timers[0]();
  assert.deepEqual(await pending, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  assert.equal(iso.state().reason, "not-isolated");
  assert.deepEqual(iso.state().detail, { A: ["check-error"] });
  assert.equal(state.grants.length, 0);
});

test("OCS-S-09 点过头之后任何舞台都不再收到票据:后来哪一台自检不过或交接失败,拿到的是不带票据的 cookie 基址;未配置 stageOrigin 则抛错拒绝退回同源", async () => {
  const { iso, state } = make();
  await bothIsolated(iso);
  assert.equal(iso.state().enabled, true);
  // B 重载成了没隔离的文档
  iso.handshake("B");
  assert.equal(iso.state().enabled, false);
  iso.report("B", BAD);
  const b = await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.deepEqual(b, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  // A 续票时交接失败:留在 cookie 上(旧 cookie 还能用到过期),同样不给票据
  state.grantOk = false;
  const a = await iso.plan("A", { active: true, stageOrigin: S1, ticket: `${TICKET}2` });
  assert.equal(a.mode, "cookie");
  assert.equal(a.ticket, null);
  // 退回单舞台(未配置 stageOrigin):抛错拒绝同源退回
  iso.setStages([]);
  assert.equal(iso.state().reason, "no-stage");
  await assert.rejects(
    () => iso.plan("A", { active: false, stageOrigin: null, ticket: TICKET }),
    /跨源隔离舞台未配置或不可用/
  );
});

test("OCS-S-10 加固拦下过试图造子框架的代码:本页会话不再执行;订阅方收到通知", async () => {
  const { iso } = make();
  let calls = 0;
  iso.subscribe(() => { calls++; });
  await bothIsolated(iso);
  const before = calls;
  iso.breach("create");
  assert.equal(calls, before + 1);
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "breach" });
  const a = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.deepEqual(a, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  // 重新握手、重新自检通过也不恢复
  iso.handshake("A"); iso.report("A", OK);
  await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(iso.state().reason, "breach");
});

test("OCS-S-11 等自检的时候这一台又握手了(换了文档):这一次作废;还没有票据时不交接、也不退回旧办法", async () => {
  const { iso, state } = make();
  iso.setStages(["A", "B"]);
  iso.handshake("A");
  const stale = iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  iso.handshake("A");
  const r = await stale;
  assert.equal(r.cardExec, false);
  assert.equal(state.grants.length, 0);
  iso.report("A", OK);
  const noTicket = await iso.plan("A", { active: true, stageOrigin: S1, ticket: null });
  assert.deepEqual(noTicket, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  assert.equal(state.grants.length, 0);
});

test("OCS-S-12 会话号:32 位十六进制,每次不同;交接请求是带凭据的跨源 POST、票据只在 Authorization 头里,204 才算成", async () => {
  const sid = newSid();
  assert.match(sid, /^[0-9a-f]{32}$/);
  assert.notEqual(sid, newSid());
  assert.equal(newSid((b) => b.fill(0xab)), "ab".repeat(16));
  const calls = [];
  const fetchImpl = (status) => async (url, init) => { calls.push({ url, init }); return { status }; };
  assert.equal(await grantMediaCookie(S1, SID, TICKET, fetchImpl(204)), true);
  assert.equal(calls[0].url, `${S1}/media-s/${SID}/_grant`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "include");
  assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${TICKET}` });
  assert.ok(!calls[0].url.includes(TICKET), "票据不进地址");
  assert.equal(calls[0].init.body, undefined);
  for (const status of [200, 401, 403, 404, 500]) assert.equal(await grantMediaCookie(S1, SID, TICKET, fetchImpl(status)), false, String(status));
  assert.equal(await grantMediaCookie(S1, SID, TICKET, async () => { throw new TypeError("Failed to fetch"); }), false);
  const n = calls.length;
  assert.equal(await grantMediaCookie(S1, "bad sid", TICKET, fetchImpl(204)), false);
  assert.equal(calls.length, n, "会话号不对就不发请求");
});

test("OCS-S-13 本页的那一份:没建会话(桌面运行环境、还没挂舞台)回「没有舞台、不执行」;总开关经 enabled 读", async () => {
  resetPageStageIsolationForTest();
  assert.deepEqual({ enabled: onlineCardExec().enabled, reason: onlineCardExec().reason }, { enabled: false, reason: "no-stage" });
  let on = false, calls = 0;
  const off = subscribeOnlineCardExec(() => { calls++; });
  const iso = pageStageIsolation(() => on);
  assert.equal(pageStageIsolation(), iso, "同一页只有一份");
  iso.setStages(["A", "B"]);
  assert.equal(onlineCardExec().reason, "switch-off");
  assert.ok(calls >= 1);
  on = true;
  iso.handshake("A");
  assert.equal(onlineCardExec().reason, "pending");
  off();
  resetPageStageIsolationForTest();
});

test("OCS-S-14 只有一个舞台(舞台闸门第一级、握手失败退回):跨源单舞台 A 自检通过、交接成功就能执行,不看 B;B 不在布局里不给票据", async () => {
  const { iso } = make();
  iso.setStages(["A"]);
  assert.equal(iso.state().reason, "pending", "还没自检:等着");
  iso.handshake("A");
  iso.report("A", OK);
  const a = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(a.mode, "cookie");
  assert.equal(a.ticket, null, "票据不经 RPC");
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: true, reason: "ok" }, "单舞台同样跨源隔离:能执行用户卡与素材效果卡");
  const b = await iso.plan("B", { active: false, stageOrigin: S2, ticket: TICKET });
  assert.equal(b.ticket, null, "不在布局里的那一台不给票据");
  // 换回两个舞台:B 还没自检,回到等着
  iso.setStages(["A", "B"]);
  assert.equal(iso.state().enabled, false);
  // 一台都不挂
  iso.setStages([]);
  assert.equal(iso.state().reason, "no-stage");
});

test("(f) 路径号按账号加项目固定(createStageSidStore 与会话 setScope / reload):同账号同项目稳定复用、跨项目跨账号隔离、存储异常与脏值兜底、缺标识不碰存储、换项目强制重载舞台且守单向规矩", async () => {
  const backing = new Map();
  let getCalls = 0, setCalls = 0;
  const fakeStorage = {
    getItem(k) { getCalls++; return backing.has(k) ? backing.get(k) : null; },
    setItem(k, v) { setCalls++; backing.set(k, v); },
  };

  // 1. 同一账号+同一项目 -> 同一 sid;键名 pc.stageSid.v1:<accountId>:<projectId>
  const store1 = createStageSidStore({ storage: fakeStorage });
  const scopeA = { accountId: "acct:1", projectId: "proj/alpha" };
  const scopeB = { accountId: "acct:1", projectId: "proj/beta" };
  const scopeC = { accountId: "acct:2", projectId: "proj/alpha" };
  const sidA1 = store1.sidFor(scopeA);
  assert.match(sidA1, /^[0-9a-f]{32}$/);
  assert.equal(store1.sidFor(scopeA), sidA1, "同一 store 内同账号同项目复用同一 sid");
  const expectedKeyA = `${STAGE_SID_STORAGE_PREFIX}${encodeURIComponent(scopeA.accountId)}:${encodeURIComponent(scopeA.projectId)}`;
  assert.equal(backing.get(expectedKeyA), sidA1);

  // 2. 两个 store 共用同一份存储(模拟新开页面会话) -> 同一 sid
  const store2 = createStageSidStore({ storage: fakeStorage });
  assert.equal(store2.sidFor(scopeA), sidA1, "新页面会话从 localStorage 读回同一 sid");

  // 3. 不同项目 -> 不同 sid;4. 不同账号 -> 不同 sid
  const sidB1 = store1.sidFor(scopeB);
  const sidC1 = store1.sidFor(scopeC);
  assert.match(sidB1, /^[0-9a-f]{32}$/);
  assert.match(sidC1, /^[0-9a-f]{32}$/);
  assert.notEqual(sidB1, sidA1, "同账号不同项目 sid 不同");
  assert.notEqual(sidC1, sidA1, "不同账号同项目号 sid 不同");
  assert.notEqual(sidC1, sidB1);

  // 5. getItem 或 setItem 抛错(或读取 storage 本身抛错) -> 退回内存随机 32 位十六进制 sid,store 内稳定、不同作用域不同
  for (const badStorage of [
    { getItem() { throw new Error("SecurityError: getItem blocked"); }, setItem() { throw new Error("SecurityError"); } },
    { getItem() { return null; }, setItem() { throw new Error("QuotaExceededError"); } },
    () => { throw new Error("SecurityError: localStorage getter blocked"); },
  ]) {
    const fallbackStore = createStageSidStore({ storage: badStorage });
    const fa = fallbackStore.sidFor(scopeA);
    const fb = fallbackStore.sidFor(scopeB);
    assert.match(fa, /^[0-9a-f]{32}$/);
    assert.match(fb, /^[0-9a-f]{32}$/);
    assert.equal(fallbackStore.sidFor(scopeA), fa, "存储抛错时同一作用域在会话内仍稳定");
    assert.equal(fallbackStore.sidFor(scopeB), fb);
    assert.notEqual(fa, fb, "存储抛错时不同作用域仍不共用 sid");
  }

  // 6. 存储里是脏值 -> 换新 sid 并覆盖写回
  for (const garbage of ["not-a-sid", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef", `${"a".repeat(32)}-extra`]) {
    backing.set(expectedKeyA, garbage);
    const cleanStore = createStageSidStore({ storage: fakeStorage });
    const fresh = cleanStore.sidFor(scopeA);
    assert.match(fresh, /^[0-9a-f]{32}$/);
    assert.notEqual(fresh, garbage);
    assert.equal(backing.get(expectedKeyA), fresh, "脏值被新生成的合法 sid 覆盖");
  }

  // 7. 缺少任一 id -> 绝不触碰 storage,不同缺省作用域仍拿到各自稳定且互不相同的内存 sid
  let touched = 0;
  const forbidStorage = {
    getItem() { touched++; return null; },
    setItem() { touched++; },
  };
  const memStore = createStageSidStore({ storage: () => { touched++; return forbidStorage; } });
  const m1 = memStore.sidFor({ accountId: null, projectId: "proj-1" });
  const m2 = memStore.sidFor({ accountId: null, projectId: "proj-2" });
  const m3 = memStore.sidFor({ accountId: "acct-1", projectId: null });
  const m4 = memStore.sidFor({ accountId: "", projectId: "proj-1" });
  const m5 = memStore.sidFor({ accountId: null, projectId: null });
  assert.equal(touched, 0, "缺账号或项目标识时绝不访问 storage");
  for (const s of [m1, m2, m3, m4, m5]) assert.match(s, /^[0-9a-f]{32}$/);
  assert.equal(new Set([m1, m2, m3, m4]).size, 4, "不同缺标识作用域互不共用 sid");
  assert.equal(memStore.sidFor({ accountId: null, projectId: "proj-1" }), m1, "同一缺标识作用域在会话内稳定");
  assert.equal(memStore.sidFor({ accountId: null, projectId: null }), m5);
  assert.ok(getCalls > 0 && setCalls > 0);

  // 8. 会话级:setScope(B) 后已拿过 A 的 sid 的舞台返回 reload: true、不给新基址、不发 grant、cardExec 为假、状态未启用;
  //    重载前切回 A 则清除 reload 需求并恢复就绪;握手后才拿到 B 的 sid 并用同一张票据为 B 的 sid 重新交接;单向规矩保持有效。
  const sessionBacking = new Map();
  const sessionStorage = {
    getItem: (k) => sessionBacking.get(k) ?? null,
    setItem: (k, v) => { sessionBacking.set(k, v); },
  };
  const state = { enabled: true, grantOk: true, grants: [], notifications: 0 };
  const iso = createStageIsolation({
    enabled: () => state.enabled,
    storage: sessionStorage,
    grant: async (origin, s, ticket) => { state.grants.push({ origin, sid: s, ticket }); return state.grantOk; },
    setTimer: () => 1,
    clearTimer: () => {},
  });
  iso.subscribe(() => { state.notifications++; });
  iso.setStages(["A", "B"]);
  iso.setScope(scopeA);
  const sidA = iso.sid;
  assert.match(sidA, /^[0-9a-f]{32}$/);
  const notifyBeforeSameScope = state.notifications;
  iso.setScope({ ...scopeA });
  assert.equal(state.notifications, notifyBeforeSameScope, "相同作用域重复 setScope 是空操作、不触发通知");

  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", OK);
  const planA1 = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  const planB1 = await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.equal(planA1.base, `/media-s/${sidA}`);
  assert.equal(planB1.base, `/media-s/${sidA}`);
  assert.equal(planB1.cardExec, true);
  assert.equal(iso.state().enabled, true);
  assert.equal(state.grants.length, 2);

  // 切换到项目 B:sid 变为 sidB,状态立刻变为未就绪(pending),对已拿过 sidA 的槽位 plan 返回 reload: true
  const notifyBeforeSwitch = state.notifications;
  iso.setScope(scopeB);
  const sidB = iso.sid;
  assert.notEqual(sidB, sidA);
  assert.equal(state.notifications, notifyBeforeSwitch + 1, "切换作用域改变就绪状态时通知一次订阅方");
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "pending" });

  const reloadA = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.deepEqual(reloadA, { mode: "cookie", base: null, ticket: null, cardExec: false, reload: true });
  assert.equal(state.grants.length, 2, "需要重载时不发新的交接请求");
  // 安全兜底分支(active 为假、或 ticket 为空)同样不能把第二个 sid 交给旧文档
  assert.deepEqual(await iso.plan("A", { active: false, stageOrigin: S1, ticket: TICKET }), { mode: "cookie", base: null, ticket: null, cardExec: false, reload: true });
  assert.deepEqual(await iso.plan("B", { active: true, stageOrigin: S2, ticket: null }), { mode: "cookie", base: null, ticket: null, cardExec: false, reload: true });

  // 重载(handshake)发生前切回项目 A:清除 reload 需求,直接恢复可执行且不重复交接
  iso.setScope(scopeA);
  assert.equal(iso.sid, sidA);
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: true, reason: "ok" });
  const backToA = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.deepEqual(backToA, { mode: "cookie", base: `/media-s/${sidA}`, ticket: null, cardExec: true });
  assert.equal(state.grants.length, 2, "切回 A 时旧交接仍有效,不重发交接");

  // 再次切到项目 B,模拟两台舞台整页重载后重新握手:拿到 sidB,同一张票据也为 sidB 重新交接
  iso.setScope(scopeB);
  assert.equal(iso.state().enabled, false);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", OK);
  const planA2 = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  const planB2 = await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.deepEqual(planA2, { mode: "cookie", base: `/media-s/${sidB}`, ticket: null, cardExec: false });
  assert.deepEqual(planB2, { mode: "cookie", base: `/media-s/${sidB}`, ticket: null, cardExec: true });
  assert.equal(iso.state().enabled, true);
  assert.deepEqual(state.grants.slice(2), [
    { origin: S1, sid: sidB, ticket: TICKET },
    { origin: S2, sid: sidB, ticket: TICKET },
  ], "同一张票据与舞台源在新 sid 下必须重新交接");

  // 单向规矩 1:点过头之后切到项目 C,即使自检不过或交接失败也绝不退回带票据的旧办法
  iso.setScope(scopeC);
  const sidC = iso.sid;
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", BAD);
  state.grantOk = false;
  iso.report("B", OK);
  const badA = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  const failB = await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.deepEqual(badA, { mode: "cookie", base: `/media-s/${sidC}`, ticket: null, cardExec: false });
  assert.deepEqual(failB, { mode: "cookie", base: `/media-s/${sidC}`, ticket: null, cardExec: false });
  assert.equal(iso.state().enabled, false);

  // 单向规矩 2:出过 breach 之后切换作用域并重握手也绝不恢复执行
  state.grantOk = true;
  iso.breach("create");
  iso.setScope(scopeA);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", OK);
  const afterBreach = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(afterBreach.cardExec, false);
  assert.equal(afterBreach.ticket, null);
  assert.equal(iso.state().reason, "breach");
});

test("(g) 页面原地换项目、素材连接还没换过来:卡片代码的项目与素材的项目不同,本页当场不点头执行(新项目的代码不进拿着上一个项目路径号的舞台文档);素材换过来后路径号变、要求整页重载;Preview 发包前先重算作用域", async () => {
  const backing = new Map();
  const storage = { getItem: (k) => backing.get(k) ?? null, setItem: (k, v) => { backing.set(k, v); } };
  const state = { grants: [], notifications: 0 };
  const iso = createStageIsolation({
    enabled: () => true,
    storage,
    grant: async (origin, s, ticket) => { state.grants.push({ origin, sid: s, ticket }); return true; },
    setTimer: () => 1,
    clearTimer: () => {},
  });
  iso.subscribe(() => { state.notifications++; });
  iso.setScope({ accountId: "acct-1", projectId: "A", codeProjectId: "A" });
  const sidA = iso.sid;
  const { a, b } = await bothIsolated(iso);
  assert.equal(a.base, `/media-s/${sidA}`);
  assert.equal(b.cardExec, true);
  assert.equal(iso.state().enabled, true);

  // 项目已换成 B、素材连接仍是 A:路径号不变(cookie 里还是 A 的票据),但本页立刻不执行,并通知订阅方(Preview 据此重发策略、关掉舞台的闸门)
  const before = state.notifications;
  iso.setScope({ accountId: "acct-1", projectId: "A", codeProjectId: "B" });
  assert.equal(iso.sid, sidA);
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "pending" });
  assert.equal(state.notifications, before + 1);
  const during = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(during.cardExec, false, "对不上的这一段发给舞台的策略不点头");
  assert.equal(during.ticket, null);
  // 同一组再报一次是空操作
  iso.setScope({ accountId: "acct-1", projectId: "A", codeProjectId: "B" });
  assert.equal(state.notifications, before + 1);

  // 素材连接换成 B:路径号换成 B 的,拿过 A 的路径号的舞台文档要整页重载
  iso.setScope({ accountId: "acct-1", projectId: "B", codeProjectId: "B" });
  const sidB = iso.sid;
  assert.notEqual(sidB, sidA);
  assert.equal(iso.state().enabled, false);
  assert.equal((await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET })).reload, true);
  assert.equal((await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET })).reload, true);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", OK);
  const a2 = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  const b2 = await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.equal(a2.base, `/media-s/${sidB}`);
  assert.equal(b2.cardExec, true);
  assert.equal(iso.state().enabled, true);

  // 没有素材连接(本地项目、局域网项目不给账号项目号)时只按打开的项目算,不算对不上
  iso.setScope({ accountId: null, projectId: "L", codeProjectId: "L" });
  assert.notEqual(iso.state().reason, "ok");
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", OK);
  await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.equal(iso.state().enabled, true);

  // 接线(源码核对):Preview 的作用域里带 codeProjectId,发卡片包之前先重算作用域再看能不能执行
  const fs = await import("node:fs");
  const preview = fs.readFileSync(new URL("../editor/Preview.tsx", import.meta.url), "utf8");
  assert.match(preview, /codeProjectId = currentDocProjectId\(\) \|\| null/);
  assert.match(preview, /projectId: remoteAccountProjectId\(\) \|\| codeProjectId, codeProjectId/);
  const push = preview.indexOf("const pushCardBundles = useCallback(");
  const scoped = preview.indexOf(".setScope(stageSidScope());", push);
  const decided = preview.indexOf("cardExecAvailable()", push);
  assert.ok(push > 0 && scoped > push && scoped < decided, "pushCardBundles 先 setScope 再判 cardExecAvailable");
  // 2026-10-23 审查 P2:取票据要等;等的时候素材连接或打开的项目换了,这张票据作废,不交到按新作用域算的路径号下
  const media = preview.indexOf("const pushMediaPolicy = useCallback(");
  const captured = preview.indexOf("const scopeBefore = scopeKey();", media);
  const awaited = preview.indexOf("await remoteAssetTicket()", media);
  const recheck = preview.indexOf("if (scopeKey() !== scopeBefore) return;", media);
  const mediaScoped = preview.indexOf("iso.setScope(stageSidScope());", media);
  assert.ok(media > 0 && captured > media && awaited > captured && recheck > awaited && mediaScoped > recheck, "pushMediaPolicy:等票据前后各读一次作用域,不一致就放弃,再定路径号");
  assert.match(preview, /const scopeKey = \(\) => JSON\.stringify\(\[remoteAssetBase\(\), stageSidScope\(\)\]\);/, "作用域含素材连接与打开的项目");
  // 原地换项目(`plan.reload`):重建舞台 iframe 元素(key 带 stageFrameGen),不用 `frame.src = frame.src`(免得旧浏览上下文的会话历史留着)
  const reloadBranch = preview.indexOf("if (plan.reload)", media);
  const bumpGen = preview.indexOf("setStageFrameGen((prev) => ({ ...prev, [id]: prev[id] + 1 }));", reloadBranch);
  assert.ok(reloadBranch > mediaScoped && bumpGen > reloadBranch && bumpGen < preview.indexOf("return;", reloadBranch), "plan.reload 分支递增 stageFrameGen 重建舞台 iframe");
  assert.ok(!preview.slice(reloadBranch, preview.indexOf("return;", reloadBranch)).includes("frame.src"), "plan.reload 不再原地赋 frame.src");
  for (const key of ["single-${stageFrameGen.A}", "dualA-${stageFrameGen.A}", "dualB-${stageFrameGen.B}"]) {
    assert.ok(preview.includes(`key={\`${key}\`}`), `舞台 iframe key 带重建代数: ${key}`);
  }
});
