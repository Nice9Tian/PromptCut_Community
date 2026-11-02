/**
 * Evaluation on the parent page side for cards that cannot run on this device in online browser mode
 * (user cards, media effect cards, user cards synced from content store) (C10 contract section 9;
 * user semantic change, 2026-09-29).
 * Run: node --experimental-test-module-mocks --test src/editor/onlineUserCards.test.mjs
 *
 *   OU-01 `clipIdentityOf`: do not assign identity when online (unmeasured, no old cost records found,
 *         no declared frame mode found); desktop as usual; updates when sync table changes; unknown cards
 *         defined on neither side get no identity on either desktop or online
 *   OU-05 Unknown cards: unmeasured, not treated as heavy cards, not added to prerender set (consistent
 *         between desktop and online); once definitions arrive (hot reloaded / synced), enter table as usual
 *   OU-02 `planDispatch`: all classified as heavy and enter prerender set (manifest plan published by
 *         page includes them accordingly), even if old light records remain in L2; recomputed even if sync
 *         table arrives late; synced cards without definitions must not crash table calculation
 *   OU-03 Timeline: labels take build-time name → sync name → "Unknown card" in order; badge appears only
 *         when all three hold: "online, cannot run locally, does not cover full clip"
 *   OU-04 Card source sync (`sync/onlineCardSources.ts`): list, fetch, parse into registry; do not fetch
 *         body again if hash unchanged; clear table on connection change; table remains unchanged if fetch fails
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;

mock.module(srcUrl("editor/stageBridge.ts"), { exports: { frontStage: () => null, backStage: () => null } });
mock.module(srcUrl("render/cardSourceFiles.mjs"), { exports: { builtinCardSourceFiles: {}, cardSourceFilesVersion: () => 0 } });
mock.module(srcUrl("render/cardSourceVersion.mjs"), { exports: { cardSourceVersion: (card) => `v-${card.id}` } });

const R = await import(srcUrl("kernel/registry.ts"));
const H = await import(srcUrl("render/placeholderHost.ts"));
const CI = await import(srcUrl("editor/costIdentity.ts"));
const D = await import(srcUrl("editor/planDispatch.ts"));
const B = await import(srcUrl("editor/timeline/localPcBadge.ts"));
const S = await import(srcUrl("editor/sync/onlineCardSources.ts"));

const FPS = 30;
const dom = (id, extra = {}) => ({ id, name: `Name-${id}`, defaults: {}, controls: [], frameMode: "direct", Component: () => null, ...extra });
function setup() {
  R.resetCards();
  R.registerCards([dom("builtin"), dom("mine", { name: "Build-time user card" }), dom("graphish", { Component: undefined, card: () => ({}) })]);
  R.setUserCardSources({ mine: "" }, { mine: "mine" });
  R.setSyncedUserCards([]);
  CI.resetClipIdentityCache();
}
const clip = (id, cardId, start = 0, end = 2) => ({ id, cardId, start, end, params: {} });
const project = () => ({ version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: FPS, duration: 10, media: [],
  tracks: [{ id: "t", name: "t", clips: [clip("b", "builtin"), clip("u", "mine", 2, 4), clip("g", "graphish", 4, 6), clip("s", "synced-card", 6, 8), clip("x", "nobody", 8, 10)] }] });
const settle = () => new Promise((r) => setTimeout(r, 0));

test("OU-01 clipIdentityOf: when online, a card that cannot run on this page has no identity and a user card that can run has one; desktop as before; changes to the sync table, run state or tier change it accordingly", () => {
  setup();
  const p = project();
  try {
    const desk = CI.clipIdentityOf(p);
    for (const id of ["b", "u"]) assert.ok(desk.identityKeys[id], `Desktop: ${id} has an identity`);
    for (const id of ["s", "x"]) assert.equal(desk.identityKeys[id], undefined, `Desktop: ${id} is defined on neither side (unknown card), gets no identity and is not measured`);
    assert.ok(desk.frameModes.b && desk.frameModes.u);
    H.setOnlineBrowserMode(true);
    const on1 = CI.clipIdentityOf(p);
    assert.notEqual(on1, desk, "The old memo is not used after the mode changed");
    assert.ok(on1.identityKeys.b, "Built-in cards still have an identity");
    assert.equal(on1.identityKeys.s, undefined, "The sync table has not arrived: s is still an unknown card, no identity (not measured)");
    assert.equal(on1.identityKeys.x, undefined, "Unknown cards get no identity");
    // 2026-10-06 (online-card-exec-contract.md section 6): repository user cards already in the online
    // bundle at build time are the page's own code, can run on this page, and get identity like built-in cards
    assert.equal(on1.identityKeys.u, desk.identityKeys.u, "Build-time user card: has an identity (same key as on desktop)");
    assert.equal(on1.frameModes.u, "direct");
    assert.equal(on1.capabilities.has("u"), true);
    assert.equal(on1.identityKeys.g, undefined, "Media effect card: no identity (online execution of media effect cards is not enabled yet)");
    R.setSyncedUserCards([{ id: "synced-card", name: "Synced card", defaults: { n: 1 } }]);
    const on2 = CI.clipIdentityOf(p);
    assert.equal(on2.identityKeys.s, undefined, "The sync table has arrived but there is no run state yet: the synced card has no identity");
    assert.equal(on2.identityKeys.x, undefined, "An id that exists on neither side still has no identity");
    assert.equal(CI.clipIdentityOf(p), on2, "Use the memo when nothing changed");
    // Runtime status: only ready has identity; source version takes the short signature of this generation,
    // changing key upon generation change
    for (const state of ["loading", "unsupported-syntax", "missing-module", "load-error", "gpu", "media", "runtime-error", "not-isolated"]) {
      R.setCardRunStates([["synced-card", { state }]]);
      assert.equal(CI.clipIdentityOf(p).identityKeys.s, undefined, `${state}: cannot run on this page, no identity`);
    }
    R.setCardRunStates([["synced-card", { state: "ready", version: "g1" }]]);
    const ready1 = CI.clipIdentityOf(p);
    assert.equal(typeof ready1.identityKeys.s, "string", "ready: has an identity, measured like a built-in card");
    assert.equal(ready1.capabilities.has("s"), true);
    R.setCardRunStates([["synced-card", { state: "ready", version: "g2" }]]);
    assert.notEqual(CI.clipIdentityOf(p).identityKeys.s, ready1.identityKeys.s, "Source generation changed: the identity changes too (measure again)");
    // As of 2026-10-21, do not block user cards separately by tier: build-time user cards can run on this
    // page, and have identity like built-in cards at the lowest tier or when evaluated by bounds search
    // (stop to catch up exact frames)
    D.setPlanLowest(true);
    D.setPlanSearch(true);
    const low = CI.clipIdentityOf(p);
    assert.ok(low.identityKeys.u, "Lowest tier: build-time user cards still have an identity");
    assert.ok(low.identityKeys.b, "Lowest tier: built-in cards still have an identity");
    D.setPlanLowest(false);
    D.setPlanSearch(false);
    assert.ok(CI.clipIdentityOf(p).identityKeys.u, "Both off: still has one");
  } finally {
    H.setOnlineBrowserMode(false);
    R.setSyncedUserCards([]);
    R.setCardRunStates([]);
    D.resetPlanDispatch();
  }
});

test("OU-02 planDispatch: when online, cards that cannot run on this page are always classified as heavy and go into the prerender set, and old classify-as-light records are ignored; user cards that can run are classified by their record; a late sync table or run state also triggers a recompute", async () => {
  setup();
  const p = project();
  // Desktop-standard identity key → each has a very light cost record (simulating old records previously
  // measured on the background stage in L2)
  const keys = CI.clipIdentityOf(p).identityKeys;
  const lightRec = (key) => ({ identityKey: key, fps: FPS, device: "d", measuredAt: 1, stepMs: 0.2, kind: "random", vtOk: true, seekOk: true, seekMs: 0.2, catchUpMs: 0.2 });
  D.resetPlanDispatch();
  D.setPlanCosts(Object.values(keys).map(lightRec), null);
  D.setPlanProject(p);
  await settle();
  const desk = D.currentPlan().prerenderSet;
  for (const id of ["b", "u", "s", "x"]) assert.equal(desk.has(id), false, `Desktop: ${id} classified as light by the old record`);
  try {
    H.setOnlineBrowserMode(true);
    CI.resetClipIdentityCache();
    D.setPlanCosts(Object.values(keys).map(lightRec), null);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g"], "Online: media effect card classified as heavy; build-time user cards can run on this page and are classified as light by their record; sync table has not arrived");
    R.setSyncedUserCards([{ id: "synced-card", name: "Synced card" }]);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "s"], "Sync table has arrived but is not loaded yet: synced cards with no definition are classified as heavy, and building the table does not crash");
    // Manifest plan published by the page takes card clips by prerenderSet (Preview's clips()): includes
    // synced cards that cannot run
    const byId = new Map(p.tracks[0].clips.map((c) => [c.id, c]));
    assert.deepEqual([...D.currentPlan().prerenderSet].filter((id) => !!byId.get(id)?.cardId), ["g", "s"]);
    // Load succeeded (runtime status ready): has identity; when there is no record yet, fall back to
    // declaration (synced cards have no declaration, classified as heavy); once records arrive, evaluate by records
    let planNotifications = 0;
    const offPlan = D.onPlanUpdated(() => { planNotifications++; });
    try {
      R.setCardRunStates([["synced-card", { state: "ready", version: "g1" }]]);
      await settle();
      assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "s"], "Just loaded successfully, not measured yet: fall back to what the card declares");
      assert.equal(planNotifications, 1, "When the run state becomes ready, notify that the dispatch table has been updated");
      D.mergePlanCosts([lightRec(CI.clipIdentityOf(p).identityKeys.s)]);
      await settle();
      assert.deepEqual([...D.currentPlan().prerenderSet], ["g"], "Measured and classified as light: not in the prerender set, live rendered");
      assert.equal(planNotifications, 2, "After the measurement record is merged in, notify again that the dispatch table has been updated (Preview recomputes the paused frame from this)");
    } finally {
      offPlan();
    }
    // Can no longer run (transpilation failed for the new generation): revert to classifying all as heavy,
    // ignoring the cached light record on hand
    R.setCardRunStates([["synced-card", { state: "unsupported-syntax", detail: "namespace" }]]);
    await settle();
    assert.deepEqual([...D.currentPlan().prerenderSet], ["g", "s"], "Cannot run: classified as heavy");
    // When there is only one stage and evaluating by bounds search (as of 2026-10-21, do not block user cards
    // separately by tier): build-time user cards are evaluated by bounds search results like built-in cards
    D.setPlanSearch(true);
    D.setPlanSearchLight([keys.b, keys.u]);
    await settle();
    assert.equal(D.judgedPlan().prerenderSet.has("u"), false, "Judged by bounds search: build-time user cards are classified as light according to the bounds search result");
    assert.equal(D.judgedPlan().prerenderSet.has("b"), false, "Judged by bounds search: built-in cards are classified as light according to the bounds search result");
  } finally {
    H.setOnlineBrowserMode(false);
    R.setSyncedUserCards([]);
    R.setCardRunStates([]);
    D.resetPlanDispatch();
  }
});

test("OU-05 unknown cards (defined on neither side): desktop and online both skip measuring them, do not treat them as heavy cards and do not put them in the prerender set; once a definition arrives they enter the table as usual", async () => {
  setup();
  // x declares stateful: with no cost record, falling back to declaration classifies as heavy; unknown
  // cards cannot reach this step
  const p = { ...project(), tracks: [{ id: "t", name: "t", clips: [clip("b", "builtin"), clip("x", "nobody", 0, 2)] }] };
  assert.equal(R.isKnownCardId("builtin"), true);
  assert.equal(R.isKnownCardId("mine"), true);
  assert.equal(R.isKnownCardId("nobody"), false);
  assert.deepEqual([...R.unknownCardClipIds([...p.tracks[0].clips, { id: "n", nodeId: "node-n", start: 0, end: 2 }])], ["x"], "Only clips that have a cardId are considered; those with only a nodeId do not count");
  assert.equal(D.knownCardsOnly(project()).tracks[0].clips.some((c) => c.id === "x"), false);
  const plain = { ...project(), tracks: [{ id: "t", name: "t", clips: [clip("b", "builtin")] }] };
  assert.equal(D.knownCardsOnly(plain), plain, "With no unknown cards, the same object is returned as is");
  for (const online of [false, true]) {
    H.setOnlineBrowserMode(online);
    try {
      CI.resetClipIdentityCache();
      D.resetPlanDispatch();
      D.setPlanCosts([], null);
      D.setPlanProject(p);
      await settle();
      const tag = online ? "online" : "Desktop";
      assert.equal(CI.clipIdentityOf(p).identityKeys.x, undefined, `${tag}: unknown cards have no identity (measurement does not pick them)`);
      assert.ok(CI.clipIdentityOf(p).identityKeys.b, `${tag}: built-in cards still have an identity`);
      assert.equal(D.currentPlan().prerenderSet.has("x"), false, `${tag}: not in the prerender set (the manifest plan does not include it)`);
      assert.ok(!D.currentPlan().segments.some((sg) => sg.heavy.has("x") || sg.light.has("x")), `${tag}: not in the dispatch table`);
      D.setPlanLowest(true);
      D.setPlanSearch(true);
      await settle();
      assert.equal(D.currentPlan().prerenderSet.has("x"), false, `${tag}: not in the display table that classifies everything as heavy at the lowest tier either`);
      assert.equal(D.judgedPlan().prerenderSet.has("x"), false, `${tag}: not in the decision table judged by bounds search either`);
      D.setPlanLowest(false);
      D.setPlanSearch(false);
      await settle();
    } finally {
      H.setOnlineBrowserMode(false);
    }
  }
  // Definition arrived (hot reload installed this card): assign identity as usual, fall back to
  // declaration and classify as heavy
  D.resetPlanDispatch();
  D.setPlanCosts([], null);
  D.setPlanProject(p);
  await settle();
  R.registerCards([dom("nobody", { frameMode: "stateful" })]);
  R.noteCardsUpdated(1);
  await settle();
  assert.ok(CI.clipIdentityOf(p).identityKeys.x, "Definition arrived: has an identity");
  assert.equal(D.currentPlan().prerenderSet.has("x"), true, "Definition arrived: with no cost record, classified as heavy per the declared stateful");
  D.resetPlanDispatch();
});

test("OU-03 timeline: label; no more \"Needs local PC render assistance\" badge (removed by user decision, 2026-10-21)", () => {
  setup();
  R.setSyncedUserCards([{ id: "synced-card", name: "Probe synced card" }, { id: "builtin", name: "Collides with built-in" }]);
  try {
    assert.equal(B.clipCardLabel(R.knownCardName("mine")), "Build-time user card");
    assert.equal(B.clipCardLabel(R.knownCardName("synced-card")), "Probe synced card");
    assert.equal(B.clipCardLabel(R.knownCardName("builtin")), "Name-builtin", "A colliding synced entry is ignored");
    assert.equal(B.clipCardLabel(R.knownCardName("nobody")), "Unknown card");
    assert.equal(B.showLocalPcBadge, undefined, "The badge decision was removed");
  } finally {
    R.setSyncedUserCards([]);
  }
});

/** Mock content store: list / get such as card-source */
function fakeContent(items) {
  const store = new Map(Object.entries(items));
  const sent = [];
  let fail = false;
  return {
    sent, store,
    setFail(v) { fail = v; },
    request: async (msg) => {
      sent.push(msg);
      if (fail) throw new Error("Not connected to the document service");
      if (msg.type === "content.list") {
        const keys = [...store.keys()].filter((k) => k.startsWith(msg.prefix)).sort();
        return { type: "content.listing", kind: msg.kind, items: keys.map((key) => ({ key, hash: `h:${store.get(key).length}:${store.get(key).slice(-12)}`, rev: 1 })), truncated: false };
      }
      if (msg.type === "content.get") {
        if (!store.has(msg.key)) return { type: "content.item", kind: msg.kind, key: msg.key, missing: true };
        const body = store.get(msg.key);
        return { type: "content.item", kind: msg.kind, key: msg.key, body, hash: `h:${body.length}:${body.slice(-12)}`, rev: 1 };
      }
      return { type: "error" };
    },
  };
}
const cardSrc = (id, name) => `import type { CardDef } from "../../kernel/types";\nexport const c: CardDef = { id: "${id}", name: "${name}", defaults: {}, controls: [], Component: () => null };\n`;

test("OU-04 card source sync: list, fetch and parse into the registry; no body fetch when the hash is unchanged; only .tsx files one level under src/cards/user/ count; a changed connection clears the table; the table is left untouched when fetching fails", async () => {
  setup();
  const content = fakeContent({
    "src/cards/user/a.tsx": cardSrc("synced-a", "Synced A"),
    "src/cards/user/b.tsx": cardSrc("synced-b", "Synced B") + cardSrc("synced-b2", "Synced B2").replace("export const c", "export const c2"),
    "src/cards/user/lib/helper.tsx": cardSrc("not-entry", "Not an entry"),
    "src/cards/user/_scopes.json": "{}",
  });
  let link = { id: 1 };
  let changes = 0;
  const sources = new S.OnlineCardSources({ request: content.request, linkKey: () => link, onChange: () => changes++ });
  try {
    await sources.sync();
    assert.deepEqual([...R.syncedUserCards().keys()].sort(), ["synced-a", "synced-b", "synced-b2"]);
    assert.equal(R.knownCardName("synced-b2"), "Synced B2");
    assert.equal(R.syncedUserCards().get("synced-a").source, "src/cards/user/a.tsx");
    assert.equal(R.isUserCardId("not-entry"), false, "Files in subdirectories are not entry files");
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 2);
    assert.deepEqual(content.sent[0], { type: "content.list", kind: "card-source", prefix: "src/cards/user/" });
    assert.equal(changes, 1);
    // Another round: hash unchanged, do not fetch body again, do not notify
    await sources.sync();
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 2);
    assert.equal(changes, 1);
    // Rename: fetch only that item
    content.store.set("src/cards/user/a.tsx", cardSrc("synced-a", "Synced A renamed"));
    await sources.sync();
    assert.equal(content.sent.filter((m) => m.type === "content.get").length, 3);
    assert.equal(R.knownCardName("synced-a"), "Synced A renamed");
    // Fetch failed: table remains unchanged
    content.setFail(true);
    await sources.sync();
    assert.equal(R.syncedUserCards().size, 3);
    assert.ok(sources.debug().errors > 0);
    content.setFail(false);
    // Connection changed (switched project): clear table first, then re-fetch with new connection
    content.store.delete("src/cards/user/b.tsx");
    link = { id: 2 };
    await sources.sync();
    assert.deepEqual([...R.syncedUserCards().keys()], ["synced-a"]);
    // Leave shared project: clear
    link = null;
    await sources.sync();
    assert.equal(R.syncedUserCards().size, 0);
  } finally {
    sources.stop();
    R.setSyncedUserCards([]);
  }
});

test("OU-04b entriesOf: sorted by key, the first entry is taken for the same id", () => {
  const parsed = new Map([["src/cards/user/b.tsx", [{ id: "x", name: "x in B" }]], ["src/cards/user/a.tsx", [{ id: "x", name: "x in A" }, { id: "y", name: "y" }]]]);
  assert.deepEqual(S.entriesOf(["src/cards/user/b.tsx", "src/cards/user/a.tsx"], parsed), [
    { id: "x", name: "x in A", source: "src/cards/user/a.tsx" },
    { id: "y", name: "y", source: "src/cards/user/a.tsx" },
  ]);
});

test("OU-04c synced cards carry the description, defaults and controls: the parameters panel can see them via syncedCardView; the main registry still cannot", async () => {
  setup();
  const src = `import type { CardDef } from "../../kernel/types";
const OPTS = [{ value: "l", label: "Left" }, { value: "r", label: "Right" }];
export const c: CardDef = {
  id: "synced-p", name: "Synced card with parameters", description: "Description",
  defaults: { text: "hi", size: 48, side: "l", tint: "#ff0000" },
  controls: [
    { key: "text", label: "Text", type: "text" },
    { key: "size", label: "Font size", type: "number", min: 12, max: 200, step: 2 },
    { key: "side", label: "Position", type: "select", options: OPTS },
    { key: "tint", label: "Color", type: "color" },
  ],
  Component: () => null,
};
export const opaque: CardDef = { id: "synced-o", name: "Control not recognized", defaults: {}, controls: makeControls(), Component: () => null };
`;
  const content = fakeContent({ "src/cards/user/p.tsx": src });
  const link = { id: 1 };
  const sources = new S.OnlineCardSources({ request: content.request, linkKey: () => link });
  try {
    await sources.sync();
    const v = R.syncedCardView("synced-p");
    assert.equal(v.name, "Synced card with parameters");
    assert.equal(v.description, "Description");
    assert.deepEqual(v.defaults, { text: "hi", size: 48, side: "l", tint: "#ff0000" });
    assert.deepEqual(v.controls.map((c) => c.type), ["text", "number", "select", "color"]);
    assert.deepEqual(v.controls[2].options, [{ value: "l", label: "Left" }, { value: "r", label: "Right" }]);
    assert.equal(v.controlsIncomplete, false);
    assert.equal(R.syncedCardView("synced-o").controlsIncomplete, true);
    assert.deepEqual(R.syncedCardView("synced-o").controls, []);
    assert.equal(R.getCard("synced-p"), undefined);
  } finally {
    sources.stop();
    R.setSyncedUserCards([]);
  }
});

test("OU-06 follow imports to fetch referenced files under the same directory: only fetch what is referenced; re-fetch and re-parse when a referenced file changes; do not re-fetch on a cycle; unresolvable references say which one; built-in modules go through builtins", async () => {
  setup();
  const entry = `import type { CardDef } from "../../kernel/types";
import { SHARED } from "./shared";
import { MORE } from "./lib/more";
import { GONE } from "./gone";
import { hudControls } from "../native/hud";
export const c: CardDef = { id: "synced-i", name: "Synced card that imports controls", defaults: { text: "t" },
  controls: [...SHARED, ...MORE, ...GONE, ...hudControls], Component: () => null };
`;
  const content = fakeContent({
    "src/cards/user/i.tsx": entry,
    "src/cards/user/shared.ts": `import { MORE } from "./lib/more";
export const SHARED = [{ key: "text", label: "Text", type: "text" }];
export const ECHO = MORE;
`,
    "src/cards/user/lib/more.ts": `import { ECHO } from "../shared";
export const MORE = [{ key: "side", label: "Position", type: "select", options: ["l", "r"] }];
`,
    "src/cards/user/unused.ts": `export const X = 1;\n`,
  });
  const link = { id: 1 };
  const builtins = (k) => (k === "src/cards/native/hud.ts" ? { hudControls: [{ key: "accent", label: "Primary color", type: "color" }] } : null);
  const sources = new S.OnlineCardSources({ request: content.request, linkKey: () => link, builtins });
  const gets = () => content.sent.filter((m) => m.type === "content.get").map((m) => m.key);
  try {
    await sources.sync();
    assert.deepEqual(gets().sort(), ["src/cards/user/i.tsx", "src/cards/user/lib/more.ts", "src/cards/user/shared.ts"], "unused.ts, which is not referenced, is not fetched; ones on a cycle are not fetched again");
    const v = R.syncedCardView("synced-i");
    assert.deepEqual(v.controls.map((c) => c.key), ["text", "side", "accent"]);
    assert.deepEqual(v.controls[1].options, [{ value: "l", label: "l" }, { value: "r", label: "r" }]);
    assert.equal(v.controlsIncomplete, true);
    assert.equal(v.skippedControls.length, 1);
    assert.match(v.skippedControls[0].reason, /spread GONE could not be resolved: the content store has no file \.\/gone/);
    assert.deepEqual(sources.debug().deps, ["src/cards/user/lib/more.ts", "src/cards/user/shared.ts"]);
    // Another round: nothing changed, do not fetch
    await sources.sync();
    assert.equal(gets().length, 3);
    // Referenced file modified: re-fetch it only, re-parse entry
    content.store.set("src/cards/user/shared.ts", `export const SHARED = [{ key: "text", label: "Text changed", type: "text" }, { key: "n", label: "Number", type: "number" }];
`);
    await sources.sync();
    assert.deepEqual(gets().slice(3), ["src/cards/user/shared.ts"]);
    assert.deepEqual(R.syncedCardView("synced-i").controls.map((c) => c.label), ["Text changed", "Number", "Position", "Primary color"]);
    // Missing file was synced later: fetched, filled in, notice dismissed
    content.store.set("src/cards/user/gone.ts", `export const GONE = [];\n`);
    await sources.sync();
    assert.equal(R.syncedCardView("synced-i").controlsIncomplete, false);
    assert.deepEqual(R.syncedCardView("synced-i").skippedControls, []);
    // Referenced file was deleted from content store: return to notice
    content.store.delete("src/cards/user/lib/more.ts");
    await sources.sync();
    const v2 = R.syncedCardView("synced-i");
    assert.deepEqual(v2.controls.map((c) => c.key), ["text", "n", "accent"]);
    assert.match(v2.skippedControls[0].reason, /MORE could not be resolved/);
  } finally {
    sources.stop();
    R.setSyncedUserCards([]);
  }
});
