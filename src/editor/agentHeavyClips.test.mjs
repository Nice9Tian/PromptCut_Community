/**
 * Cloud Agent light/heavy classification before publishing prerenders (`agentHeavyClips.ts`;
 * semantics `product/agent.md` "Can leave after dispatching tasks": host only generates streams
 * for modified heavy cards).
 * Run: node --experimental-test-module-mocks --test src/editor/agentHeavyClips.test.mjs
 *
 *   JH-01 With shared cost records: single-frame duration within budget classified as light
 *         (not dispatched), exceeding budget classified as heavy (dispatched); median taken across
 *         multiple records for the same card
 *   JH-02 No records: fallback before page measurement finishes: cards declaring `direct`
 *         classified as light, rest classified as heavy; cards not defined in server registry
 *         classified as heavy (dispatched as before)
 *   JH-03 Cards in cut segments (virtual clips `<segment id>~<clip id>`) follow same rules as
 *         top-level cards; records for the same card apply to all instances
 *   JH-04 Candidates not in project (deleted after writing) omitted from both; candidate order
 *         preserved
 *   JH-05 Same dispatch table as page: result is intersection of candidates and `planPipelines`
 *         prerender set (classified as heavy when they cannot fit at the same position)
 *   JH-06 Cards with modified parameters (new identity has no records): if other identities of the
 *         same card have records, estimate from them (median), light ones not dispatched;
 *         previous identity can come from another clip of the same card in current project, or
 *         from pre-modification project recorded by caller (`cardIdentityGroups` → `opts.sameCard`)
 *   JH-07 No records at all for the same card: original fallback (stateful classified as heavy,
 *         direct classified as light); do not borrow records from other cards; different source
 *         versions do not count as same card
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = {};

mock.module(srcUrl("render/cardSourceFiles.mjs"), { exports: { builtinCardSourceFiles: {}, cardSourceFilesVersion: () => 0 } });
mock.module(srcUrl("render/cardSourceVersion.mjs"), { exports: { cardSourceVersion: (card) => `v-${card.id}` } });

const R = await import(srcUrl("kernel/registry.ts"));
const CI = await import(srcUrl("editor/costIdentity.ts"));
const P = await import(srcUrl("render/pipelinePlan.mjs"));
const J = await import(srcUrl("editor/agentHeavyClips.ts"));

const def = (id, frameMode) => ({ id, name: id, defaults: { text: "" }, controls: [], frameMode, Component: () => null });
R.registerCards([def("stateful-card", "stateful"), def("direct-card", "direct")]);

const FPS = 30;
const B = P.budgetOf(FPS); // 23.33 ms
const card = (id, cardId, start, end, params = {}) => ({ id, cardId, start, end, params: { text: id, ...params } });
const seg = (id, cutId, start, end) => ({ id, cardId: "", cutId, start, end });

function project(clips, cuts = []) {
  return { version: 1, id: "p", name: "p", width: 1280, height: 720, fps: FPS, duration: 60, themeId: "midnight", media: [], activeCutId: "A",
    tracks: [{ id: "t", name: "t", clips }], ...(cuts.length ? { cuts: [{ id: "A", name: "Cut 1" }, ...cuts] } : {}) };
}

/** Cost identity of a clip in this project (uses the same `clipIdentityOf` as classification) */
const keyOf = (p, clipId) => CI.clipIdentityOf(p).identityKeys[clipId];
/** Only check classify as heavy and light (JH-01-05 written before `estimated` was added) */
const judgeHL = (...args) => { const { heavy, light } = J.judgeHeavyClips(...args); return { heavy, light }; };
const rec = (identityKey, stepMs, env = "0000000000000001") => ({ identityKey, envFingerprint: env, stepMs, samples: 30, measuredAt: 1, mode: "build" });

test("JH-01 With a record: within budget is classified as light, over budget as heavy; with several records take the median", () => {
  CI.resetClipIdentityCache();
  const p = project([card("light", "stateful-card", 0, 4), card("heavy", "stateful-card", 5, 9, { size: 2 })]);
  const kl = keyOf(p, "light"), kh = keyOf(p, "heavy");
  assert.ok(kl && kh && kl !== kh, "The two cards each have an identity");
  // Particle card measured online at ~2 ms/frame (light); the other at 40 ms/frame (exceeds B = 23.3 ms)
  const r = judgeHL(p, [rec(kl, 2.3), rec(kh, 40)], ["light", "heavy"]);
  assert.deepEqual(r, { heavy: ["heavy"], light: ["light"] });
  // Measured on several machines for the same card: take median (1, 2, 60 → 2, light;
  // 30, 30, 1 → 30, heavy)
  const multi = judgeHL(p, [rec(kl, 1, "a000000000000001"), rec(kl, 2, "a000000000000002"), rec(kl, 60, "a000000000000003"),
    rec(kh, 30, "a000000000000001"), rec(kh, 30, "a000000000000002"), rec(kh, 1, "a000000000000003")], ["light", "heavy"]);
  assert.deepEqual(multi, { heavy: ["heavy"], light: ["light"] });
  assert.ok(B > 2.3 && B < 30);
});

test("JH-02 Without a record: direct is classified as light, the rest as heavy; a card not in the registry is classified as heavy", () => {
  CI.resetClipIdentityCache();
  const p = project([card("s", "stateful-card", 0, 4), card("d", "direct-card", 0, 4), card("u", "not-registered-card", 0, 4)]);
  const r = judgeHL(p, [], ["s", "d", "u"]);
  assert.deepEqual(r, { heavy: ["s", "u"], light: ["d"] });
  // Once records arrive (written in after online member's page finishes measuring), follow records:
  // the stateful card measured very light → do not dispatch
  const r2 = judgeHL(p, [rec(keyOf(p, "s"), 2)], ["s", "d", "u"]);
  assert.deepEqual(r2, { heavy: ["u"], light: ["s", "d"] });
});

test("JH-03 Cards inside a cut segment follow the same rule as top-level ones; a record for the same card works for both instances", () => {
  CI.resetClipIdentityCache();
  const inner = [card("X", "stateful-card", 0, 4), card("Y", "stateful-card", 4, 8, { size: 3 })];
  const p = project([seg("S", "B", 0, 8), seg("S2", "B", 10, 18)], [{ id: "B", name: "Cut 2", duration: 8, tracks: [{ id: "b1", name: "b1", clips: inner }] }]);
  const kx = keyOf(p, "S~X"), ky = keyOf(p, "S~Y");
  assert.ok(kx && ky, "Cards inside a cut segment get an identity per virtual clip");
  assert.equal(keyOf(p, "S2~X"), kx, "The cost key strips flat: the same card has the same key in both instances");
  const candidates = ["S~X", "S~Y", "S2~X", "S2~Y"];
  assert.deepEqual(judgeHL(p, [rec(kx, 2), rec(ky, 50)], candidates), { heavy: ["S~Y", "S2~Y"], light: ["S~X", "S2~X"] });
  assert.deepEqual(judgeHL(p, [], candidates), { heavy: candidates, light: [] }, "A stateful card with no record is classified as heavy");
});

test("JH-04 Candidates not in the project go on neither side; order is preserved", () => {
  CI.resetClipIdentityCache();
  const p = project([card("a", "stateful-card", 0, 4), card("b", "stateful-card", 0, 4, { k: 1 })]);
  assert.deepEqual(judgeHL(p, [], ["b", "gone", "a"]), { heavy: ["b", "a"], light: [] });
  assert.deepEqual(judgeHL(null, [], ["a"]), { heavy: [], light: [] });
  assert.deepEqual(judgeHL(p, null, []), { heavy: [], light: [] });
});

test("JH-05 Same copy as the page's dispatch: when several light cards at the same position do not fit in the budget, the ones squeezed out are classified as heavy", () => {
  CI.resetClipIdentityCache();
  // Four cards at the same position, 8 ms each: greedily packing three exceeds budget (8×3 = 24 > 23.3
  // plus frame-switching cost for heavy cards); the squeezed-out card is classified as heavy
  const clips = ["c1", "c2", "c3", "c4"].map((id, i) => card(id, "stateful-card", 0, 4, { i }));
  const p = project(clips);
  const records = clips.map((c) => rec(keyOf(p, c.id), 8));
  const r = judgeHL(p, records, clips.map((c) => c.id));
  const ids = CI.clipIdentityOf(p);
  const plan = P.planPipelines(p, records.map((x) => ({ identityKey: x.identityKey, stepMs: x.stepMs })), FPS, { identityKeys: ids.identityKeys, frameModes: ids.frameModes });
  assert.ok(r.heavy.length >= 1 && r.light.length >= 1, JSON.stringify(r));
  for (const id of r.heavy) assert.ok(plan.prerenderSet.has(id), `${id} is also classified as heavy in the page's table`);
});

test("JH-06 Parameters were changed and the new identity has no record: estimate from the records of the same card's other identities, and do not send out the light ones", () => {
  CI.resetClipIdentityCache();
  // Before modification: stateful card like particle card, page measured ~2 ms/frame
  // (like online particles)
  const before = project([card("p", "stateful-card", 0, 4, { count: 100 })]);
  const kOld = keyOf(before, "p");
  const groups = J.cardIdentityGroups(before);
  assert.deepEqual(Object.values(groups), [[kOld]], "Project before the change: this card has one identity");
  // Agent modified parameters: identity changed, new identity has no records
  const after = project([card("p", "stateful-card", 0, 4, { count: 120 })]);
  const kNew = keyOf(after, "p");
  assert.notEqual(kNew, kOld, "Changing parameters changes the cost identity");
  const records = [rec(kOld, 1.8, "a000000000000001"), rec(kOld, 2.2, "a000000000000002"), rec(kOld, 90, "a000000000000003")];
  // Pre-modification identity not provided: same card has no other identities in the project right
  // now → classified as heavy per original fallback
  assert.deepEqual(J.judgeHeavyClips(after, records, ["p"]), { heavy: ["p"], light: [], estimated: [] });
  // Provided (recorded when caller started work): estimated from median of those three records
  // (2.2 ms) → light, do not dispatch; estimated ones listed in estimated
  assert.deepEqual(J.judgeHeavyClips(after, records, ["p"], { sameCard: groups }), { heavy: [], light: ["p"], estimated: ["p"] });
  // Same card measured very heavy before modification (40 ms) → estimated heavy as well,
  // dispatched as usual
  assert.deepEqual(J.judgeHeavyClips(after, [rec(kOld, 40)], ["p"], { sameCard: groups }), { heavy: ["p"], light: [], estimated: ["p"] });
  // Once new identity's own records arrive: follow its own, no longer estimating
  assert.deepEqual(J.judgeHeavyClips(after, [...records, rec(kNew, 50)], ["p"], { sameCard: groups }), { heavy: ["p"], light: [], estimated: [] });
  // Other clips of same card in project right now have records (both parameters and length differ):
  // estimable even without sameCard
  CI.resetClipIdentityCache();
  const both = project([card("p", "stateful-card", 0, 4, { count: 120 }), card("q", "stateful-card", 5, 12, { count: 7 })]);
  const kq = keyOf(both, "q");
  assert.deepEqual(J.judgeHeavyClips(both, [rec(kq, 3)], ["p"]), { heavy: [], light: ["p"], estimated: ["p"] });
});

test("JH-07 The same card has no records at all: fall back as before; do not borrow records from other cards; a different source version does not count as the same card", () => {
  CI.resetClipIdentityCache();
  const p = project([card("s", "stateful-card", 0, 4), card("d", "direct-card", 5, 9)]);
  // Only records for direct cards exist: stateful cards do not borrow them, classified as heavy
  // per fallback
  assert.deepEqual(J.judgeHeavyClips(p, [rec(keyOf(p, "d"), 1)], ["s"]), { heavy: ["s"], light: [], estimated: [] });
  // No records at all: stateful classified as heavy, direct classified as light (same as JH-02)
  assert.deepEqual(J.judgeHeavyClips(p, [], ["s", "d"]), { heavy: ["s"], light: ["d"], estimated: [] });
  // Identity recorded by caller is keyed under a different "same card" key (e.g. legacy identity
  // whose source version changed): does not count as same card, do not borrow
  const ghost = "ghost-identity";
  assert.deepEqual(J.judgeHeavyClips(p, [rec(ghost, 1)], ["s"], { sameCard: { "stateful-card v-old": [ghost] } }),
    { heavy: ["s"], light: [], estimated: [] });
});
