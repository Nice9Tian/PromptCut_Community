/**
 * Stage isolation session on editor page side: validation of self-test results, which route each
 * stage takes to fetch assets, whether this page can execute user cards and media effect cards,
 * and ticket handover (contract `docs/plan/online-card-exec-contract.md` sections 3.1, 3.2, 4.1).
 * Run: node --test src/online/stageIsolation.test.mjs
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

/** A session: master switch and handover are both controllable; timers collected in array and manually triggered */
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
/** Both stages handshake, pass self-test, and handover succeeds */
async function bothIsolated(iso) {
  iso.setStages(["A", "B"]);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", OK);
  const a = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  const b = await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  return { a, b };
}

test("OCS-S-01 the stage iframe sandbox enables only scripts and keeping its own origin", () => {
  assert.equal(STAGE_SANDBOX, "allow-scripts allow-same-origin");
  for (const no of ["allow-popups", "allow-top-navigation", "allow-forms", "allow-modals", "allow-downloads"]) assert.ok(!STAGE_SANDBOX.includes(no), no);
});

test("OCS-S-02 self-check results sent by the stage are validated by shape; the verdict does not trust the stage's own conclusion and is recomputed from the individual facts", () => {
  assert.deepEqual(sanitizeIsolationReport(OK), OK);
  // Stage claims to pass, but facts are incomplete: recomputed as not passing
  for (const lie of [{ ...OK, csp: "meta" }, { ...OK, csp: "none" }, { ...OK, crossOrigin: false }, { ...OK, hardened: false }, { ...OK, reasons: ["meta-only"] }]) {
    assert.equal(sanitizeIsolationReport(lie).ok, false, JSON.stringify(lie));
  }
  // Extra fields dropped; unrecognized reasons dropped
  const extra = sanitizeIsolationReport({ ...BAD, ticket: "x", reasons: ["meta-only", "made-up", 42] });
  assert.deepEqual(extra, BAD);
  for (const bad of [null, undefined, 42, "ok", [], {}, { ok: true }, { ...OK, csp: "response" }, { ...OK, egress: "browser" }, { ...OK, trustedTypes: "yes" }, { ...OK, ok: "true" }, { ...OK, reasons: "none" }, { ...OK, hardened: 1 }]) {
    assert.equal(sanitizeIsolationReport(bad), null, JSON.stringify(bad));
  }
  assert.equal(sanitizeBreach("create"), "create");
  for (const bad of ["", "nope", null, 1, {}]) assert.equal(sanitizeBreach(bad), null);
});

test("OCS-S-03 both stages pass the self-check and the ticket handoff succeeds: both use cookies (base /media-s/<sid>, no ticket), and this page is judged executable", async () => {
  const { iso, state } = make();
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "no-stage" });
  const { a, b } = await bothIsolated(iso);
  assert.deepEqual(a, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false }, "The other stage is not ready yet: do not approve yet");
  assert.deepEqual(b, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: true });
  assert.deepEqual(iso.state(), { enabled: true, reason: "ok", detail: {}, egress: "none" });
  assert.deepEqual(state.grants, [{ origin: S1, sid: SID, ticket: TICKET }, { origin: S2, sid: SID, ticket: TICKET }]);
  // Do not repeat handover for the same ticket; this time both stages acknowledge
  const again = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(again.cardExec, true);
  assert.equal(state.grants.length, 2);
  // Tier selection policy computed several times in a row (called again before handover completes):
  // send only one request for the same ticket
  {
    const m2 = make();
    m2.iso.setStages(["A", "B"]); m2.iso.handshake("A"); m2.iso.report("A", OK);
    const both = await Promise.all([1, 2, 3].map(() => m2.iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET })));
    assert.equal(m2.state.grants.length, 1);
    assert.ok(both.every((p) => p.mode === "cookie" && p.ticket === null));
  }
  // Ticket renewal: hand over again if ticket changes
  await iso.plan("A", { active: true, stageOrigin: S1, ticket: `${TICKET}2` });
  assert.equal(state.grants.length, 3);
  assert.equal(iso.sid, SID);
});

test("OCS-S-04 browser has no egress allowlist or Trusted Types: origin separation and handoff readiness are still executable", async () => {
  const { iso } = make();
  iso.setStages(["A", "B"]);
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", { ...OK, egress: "none" });
  await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.deepEqual({ enabled: iso.state().enabled, egress: iso.state().egress }, { enabled: true, egress: "none" });
});

test("OCS-S-05 host turned off the master switch: no handoff, no waiting for the self-check, neither stage gets a ticket (falling back to the old ticket-based approach is strictly forbidden), and the reason is the master switch; restored once turned on", async () => {
  const { iso, state } = make({ enabled: false });
  const { a, b } = await bothIsolated(iso);
  for (const p of [a, b]) assert.deepEqual(p, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  assert.equal(state.grants.length, 0);
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "switch-off" });
});

test("OCS-S-06 one stage fails the self-check (only the <meta> fallback): that stage gets no ticket, this page does not execute, and it can say which stage and why", async () => {
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
  assert.deepEqual(state.grants.map((g) => g.origin), [S1], "The stage that failed gets no handoff");
});

test("OCS-S-07 ticket handoff fails (the stage origin has no /media-s/, third-party cookies are blocked): no ticket, this page does not execute, and the reason is the handoff", async () => {
  const { iso } = make({ grantOk: false });
  const { a } = await bothIsolated(iso);
  assert.deepEqual(a, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "grant-failed" });
});

test("OCS-S-08 no self-check result arrives after the handshake (old stage page does not send it, stage is stuck): on timeout it is treated as a self-check error, no ticket", async () => {
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

test("OCS-S-09 after approval no stage receives a ticket again: any stage that later fails the self-check or handoff gets a cookie base without a ticket; if stageOrigin is not configured it throws and refuses to fall back to the same origin", async () => {
  const { iso, state } = make();
  await bothIsolated(iso);
  assert.equal(iso.state().enabled, true);
  // B reloaded into an unisolated document
  iso.handshake("B");
  assert.equal(iso.state().enabled, false);
  iso.report("B", BAD);
  const b = await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.deepEqual(b, { mode: "cookie", base: `/media-s/${SID}`, ticket: null, cardExec: false });
  // Handover fails during A's ticket renewal: stay on cookie (old cookie usable until expiration),
  // ticket withheld likewise
  state.grantOk = false;
  const a = await iso.plan("A", { active: true, stageOrigin: S1, ticket: `${TICKET}2` });
  assert.equal(a.mode, "cookie");
  assert.equal(a.ticket, null);
  // Fallback to single stage (stageOrigin not configured): throw error to reject same-origin fallback
  iso.setStages([]);
  assert.equal(iso.state().reason, "no-stage");
  await assert.rejects(
    () => iso.plan("A", { active: false, stageOrigin: null, ticket: TICKET }),
    /Cross-origin isolated stage is not configured or unavailable/
  );
});

test("OCS-S-10 hardening blocked code that tried to create a child frame: this page session no longer executes; subscribers are notified", async () => {
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
  // Does not recover even if re-handshake and re-self-test pass
  iso.handshake("A"); iso.report("A", OK);
  await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(iso.state().reason, "breach");
});

test("OCS-S-11 this stage handshakes again while waiting for the self-check (document changed): this round is voided; with no ticket yet, no handoff and no fallback to the old approach", async () => {
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

test("OCS-S-12 session ID: 32 hex digits, different each time; the handoff request is a credentialed cross-origin POST, the ticket is only in the Authorization header, and only 204 counts as success", async () => {
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
  assert.ok(!calls[0].url.includes(TICKET), "The ticket does not go into the URL");
  assert.equal(calls[0].init.body, undefined);
  for (const status of [200, 401, 403, 404, 500]) assert.equal(await grantMediaCookie(S1, SID, TICKET, fetchImpl(status)), false, String(status));
  assert.equal(await grantMediaCookie(S1, SID, TICKET, async () => { throw new TypeError("Failed to fetch"); }), false);
  const n = calls.length;
  assert.equal(await grantMediaCookie(S1, "bad sid", TICKET, fetchImpl(204)), false);
  assert.equal(calls.length, n, "No request is sent if the session ID is wrong");
});

test("OCS-S-13 this page's instance: no session created (desktop runtime, stage not yet mounted) returns \"no stage, not executing\"; the master switch is read via enabled", async () => {
  resetPageStageIsolationForTest();
  assert.deepEqual({ enabled: onlineCardExec().enabled, reason: onlineCardExec().reason }, { enabled: false, reason: "no-stage" });
  let on = false, calls = 0;
  const off = subscribeOnlineCardExec(() => { calls++; });
  const iso = pageStageIsolation(() => on);
  assert.equal(pageStageIsolation(), iso, "Only one instance per page");
  iso.setStages(["A", "B"]);
  assert.equal(onlineCardExec().reason, "switch-off");
  assert.ok(calls >= 1);
  on = true;
  iso.handshake("A");
  assert.equal(onlineCardExec().reason, "pending");
  off();
  resetPageStageIsolationForTest();
});

test("OCS-S-14 only one stage (first level of the stage gate, falling back after handshake failure): cross-origin single stage A passes the self-check and handoff succeeds, so it can execute, ignoring B; B is not in the layout and gets no ticket", async () => {
  const { iso } = make();
  iso.setStages(["A"]);
  assert.equal(iso.state().reason, "pending", "Not self-checked yet: waiting");
  iso.handshake("A");
  iso.report("A", OK);
  const a = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(a.mode, "cookie");
  assert.equal(a.ticket, null, "Ticket does not go through RPC");
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: true, reason: "ok" }, "Single stage is also cross-origin isolated: can execute user cards and media effect cards");
  const b = await iso.plan("B", { active: false, stageOrigin: S2, ticket: TICKET });
  assert.equal(b.ticket, null, "The stage not in the layout gets no ticket");
  // Switch back to two stages: B has not self-tested yet, back to waiting
  iso.setStages(["A", "B"]);
  assert.equal(iso.state().enabled, false);
  // Mount neither stage
  iso.setStages([]);
  assert.equal(iso.state().reason, "no-stage");
});

test("(f) path ID is fixed per account plus project (createStageSidStore and session setScope / reload): stably reused for the same account and project, isolated across projects and accounts, fallback for storage errors and dirty values, no storage access when an identifier is missing, switching project forces a stage reload and keeps the one-way rule", async () => {
  const backing = new Map();
  let getCalls = 0, setCalls = 0;
  const fakeStorage = {
    getItem(k) { getCalls++; return backing.has(k) ? backing.get(k) : null; },
    setItem(k, v) { setCalls++; backing.set(k, v); },
  };

  // 1. Same account + same project -> same sid; key name pc.stageSid.v1:<accountId>:<projectId>
  const store1 = createStageSidStore({ storage: fakeStorage });
  const scopeA = { accountId: "acct:1", projectId: "proj/alpha" };
  const scopeB = { accountId: "acct:1", projectId: "proj/beta" };
  const scopeC = { accountId: "acct:2", projectId: "proj/alpha" };
  const sidA1 = store1.sidFor(scopeA);
  assert.match(sidA1, /^[0-9a-f]{32}$/);
  assert.equal(store1.sidFor(scopeA), sidA1, "Within the same store, the same account and project reuse the same sid");
  const expectedKeyA = `${STAGE_SID_STORAGE_PREFIX}${encodeURIComponent(scopeA.accountId)}:${encodeURIComponent(scopeA.projectId)}`;
  assert.equal(backing.get(expectedKeyA), sidA1);

  // 2. Two stores share the same storage (simulating opening a new page session) -> same sid
  const store2 = createStageSidStore({ storage: fakeStorage });
  assert.equal(store2.sidFor(scopeA), sidA1, "A new page session reads the same sid back from localStorage");

  // 3. Different projects -> different sids; 4. Different accounts -> different sids
  const sidB1 = store1.sidFor(scopeB);
  const sidC1 = store1.sidFor(scopeC);
  assert.match(sidB1, /^[0-9a-f]{32}$/);
  assert.match(sidC1, /^[0-9a-f]{32}$/);
  assert.notEqual(sidB1, sidA1, "Same account, different project: sid differs");
  assert.notEqual(sidC1, sidA1, "Different account, same project ID: sid differs");
  assert.notEqual(sidC1, sidB1);

  // 5. getItem or setItem throws (or reading storage itself throws) -> fall back to a random
  //    32-character hex in-memory sid, stable within the store, different for different scopes
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
    assert.equal(fallbackStore.sidFor(scopeA), fa, "When storage throws, the same scope stays stable within the session");
    assert.equal(fallbackStore.sidFor(scopeB), fb);
    assert.notEqual(fa, fb, "When storage throws, different scopes still do not share a sid");
  }

  // 6. Dirty value in storage -> replace with new sid and overwrite
  for (const garbage of ["not-a-sid", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef", `${"a".repeat(32)}-extra`]) {
    backing.set(expectedKeyA, garbage);
    const cleanStore = createStageSidStore({ storage: fakeStorage });
    const fresh = cleanStore.sidFor(scopeA);
    assert.match(fresh, /^[0-9a-f]{32}$/);
    assert.notEqual(fresh, garbage);
    assert.equal(backing.get(expectedKeyA), fresh, "The dirty value is overwritten by a newly generated valid sid");
  }

  // 7. Missing any id -> never touch storage; different default scopes still get their own stable
  //    and mutually distinct in-memory sids
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
  assert.equal(touched, 0, "Never access storage when the account or project identifier is missing");
  for (const s of [m1, m2, m3, m4, m5]) assert.match(s, /^[0-9a-f]{32}$/);
  assert.equal(new Set([m1, m2, m3, m4]).size, 4, "Different scopes with missing identifiers do not share a sid");
  assert.equal(memStore.sidFor({ accountId: null, projectId: "proj-1" }), m1, "The same scope with a missing identifier stays stable within the session");
  assert.equal(memStore.sidFor({ accountId: null, projectId: null }), m5);
  assert.ok(getCalls > 0 && setCalls > 0);

  // 8. Session-level: after setScope(B), stages that already received A's sid return reload: true,
  //    do not provide a new base URL, do not issue grant, cardExec is false, state is not enabled;
  //    switching back to A before reloading clears reload requirement and restores ready state;
  //    only gets B's sid after handshake and re-performs handoff for B's sid with the same ticket;
  //    the one-way rule remains in effect.
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
  assert.equal(state.notifications, notifyBeforeSameScope, "Repeating setScope with the same scope is a no-op and triggers no notification");

  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", OK);
  const planA1 = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  const planB1 = await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.equal(planA1.base, `/media-s/${sidA}`);
  assert.equal(planB1.base, `/media-s/${sidA}`);
  assert.equal(planB1.cardExec, true);
  assert.equal(iso.state().enabled, true);
  assert.equal(state.grants.length, 2);

  // Switch to project B: sid changes to sidB, status immediately becomes pending,
  // plan returns reload: true for slots that already took sidA
  const notifyBeforeSwitch = state.notifications;
  iso.setScope(scopeB);
  const sidB = iso.sid;
  assert.notEqual(sidB, sidA);
  assert.equal(state.notifications, notifyBeforeSwitch + 1, "Subscribers are notified once when switching scope changes the readiness state");
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "pending" });

  const reloadA = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.deepEqual(reloadA, { mode: "cookie", base: null, ticket: null, cardExec: false, reload: true });
  assert.equal(state.grants.length, 2, "No new handoff request is sent when a reload is needed");
  // Security fallback branch (active is false, or ticket is empty) likewise cannot pass the second
  // sid to the old document
  assert.deepEqual(await iso.plan("A", { active: false, stageOrigin: S1, ticket: TICKET }), { mode: "cookie", base: null, ticket: null, cardExec: false, reload: true });
  assert.deepEqual(await iso.plan("B", { active: true, stageOrigin: S2, ticket: null }), { mode: "cookie", base: null, ticket: null, cardExec: false, reload: true });

  // Switch back to project A before reload (handshake) occurs: clears reload requirement,
  // directly restores executability without repeating handoff
  iso.setScope(scopeA);
  assert.equal(iso.sid, sidA);
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: true, reason: "ok" });
  const backToA = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.deepEqual(backToA, { mode: "cookie", base: `/media-s/${sidA}`, ticket: null, cardExec: true });
  assert.equal(state.grants.length, 2, "When switching back to A the old handoff is still valid, no handoff is resent");

  // Switch to project B again, simulating both stages re-handshaking after a full-page reload:
  // obtains sidB, and the same ticket is re-handed off for sidB
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
  ], "The same ticket and stage origin must be handed off again under a new sid");

  // One-way rule 1: after nodding, switch to project C; even if self-test fails or handoff fails,
  // never fall back to the old ticket-bearing approach
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

  // One-way rule 2: after a breach has occurred, switching scope and re-handshaking will never
  // restore execution
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

test("(g) page switches project in place while the media connection has not switched yet: the card code's project differs from the media's project, so this page does not approve execution on the spot (the new project's code does not enter a stage document that holds the previous project's path ID); once the media switches over, the path ID changes and a full page reload is required; Preview recomputes the scope before sending a packet", async () => {
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

  // Project changed to B, asset connection is still A: path id remains unchanged (cookie still has
  // A's ticket), but this page halts execution immediately and notifies subscribers (Preview
  // resends policy accordingly, closing the stage gate)
  const before = state.notifications;
  iso.setScope({ accountId: "acct-1", projectId: "A", codeProjectId: "B" });
  assert.equal(iso.sid, sidA);
  assert.deepEqual({ enabled: iso.state().enabled, reason: iso.state().reason }, { enabled: false, reason: "pending" });
  assert.equal(state.notifications, before + 1);
  const during = await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  assert.equal(during.cardExec, false, "The policy sent to the stage for the mismatched segment is not approved");
  assert.equal(during.ticket, null);
  // Reporting the same group again is a no-op
  iso.setScope({ accountId: "acct-1", projectId: "A", codeProjectId: "B" });
  assert.equal(state.notifications, before + 1);

  // Asset connection switched to B: path id changes to B's; stage documents that took A's path id
  // must undergo a full-page reload
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

  // When there is no asset connection (local projects and LAN projects do not provide an account
  // project id), only compute by the opened project; not considered a mismatch
  iso.setScope({ accountId: null, projectId: "L", codeProjectId: "L" });
  assert.notEqual(iso.state().reason, "ok");
  iso.handshake("A"); iso.handshake("B");
  iso.report("A", OK); iso.report("B", OK);
  await iso.plan("A", { active: true, stageOrigin: S1, ticket: TICKET });
  await iso.plan("B", { active: true, stageOrigin: S2, ticket: TICKET });
  assert.equal(iso.state().enabled, true);

  // Wiring (source check): Preview's scope includes codeProjectId; before sending the card bundle,
  // recalculate scope first then check whether it can execute
  const fs = await import("node:fs");
  const preview = fs.readFileSync(new URL("../editor/Preview.tsx", import.meta.url), "utf8");
  assert.match(preview, /codeProjectId = currentDocProjectId\(\) \|\| null/);
  assert.match(preview, /projectId: remoteAccountProjectId\(\) \|\| codeProjectId, codeProjectId/);
  const push = preview.indexOf("const pushCardBundles = useCallback(");
  const scoped = preview.indexOf(".setScope(stageSidScope());", push);
  const decided = preview.indexOf("cardExecAvailable()", push);
  assert.ok(push > 0 && scoped > push && scoped < decided, "pushCardBundles calls setScope before deciding cardExecAvailable");
  // 2026-10-23 review P2: fetching ticket requires waiting; if asset connection or opened project
  // changes while waiting, this ticket is invalidated, not handed over to the path id computed
  // under the new scope
  const media = preview.indexOf("const pushMediaPolicy = useCallback(");
  const captured = preview.indexOf("const scopeBefore = scopeKey();", media);
  const awaited = preview.indexOf("await remoteAssetTicket()", media);
  const recheck = preview.indexOf("if (scopeKey() !== scopeBefore) return;", media);
  const mediaScoped = preview.indexOf("iso.setScope(stageSidScope());", media);
  assert.ok(media > 0 && captured > media && awaited > captured && recheck > awaited && mediaScoped > recheck, "pushMediaPolicy: read the scope once before and once after awaiting the ticket, abandon if they differ, then decide the path number");
  assert.match(preview, /const scopeKey = \(\) => JSON\.stringify\(\[remoteAssetBase\(\), stageSidScope\(\)\]\);/, "The scope includes the asset connection and the open project");
  // In-place project switch (`plan.reload`): rebuild the stage iframe element (key includes
  // stageFrameGen), do not use `frame.src = frame.src` (to avoid retaining session history of the old
  // browsing context)
  const reloadBranch = preview.indexOf("if (plan.reload)", media);
  const bumpGen = preview.indexOf("setStageFrameGen((prev) => ({ ...prev, [id]: prev[id] + 1 }));", reloadBranch);
  assert.ok(reloadBranch > mediaScoped && bumpGen > reloadBranch && bumpGen < preview.indexOf("return;", reloadBranch), "The plan.reload branch increments stageFrameGen to rebuild the stage iframe");
  assert.ok(!preview.slice(reloadBranch, preview.indexOf("return;", reloadBranch)).includes("frame.src"), "plan.reload no longer assigns frame.src in place");
  for (const key of ["single-${stageFrameGen.A}", "dualA-${stageFrameGen.A}", "dualB-${stageFrameGen.B}"]) {
    assert.ok(preview.includes(`key={\`${key}\`}`), `The stage iframe key carries the rebuild generation: ${key}`);
  }
});
