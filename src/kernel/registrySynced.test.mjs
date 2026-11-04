/**
 * User cards in the registry that are "known but cannot run on this machine" (C10 Contract
 * Section 9 "Recognition"). Run:
 *   node --test src/kernel/registrySynced.test.mjs
 *
 * Pinned: synced table does not enter main registry (`allCards` / `getCard` cannot see it);
 * `isUserCardId` = build-time custom card registration or synced table; synced entries that collide
 * with build-time card IDs are ignored (built-in wins); display name resolves in order: build-time
 * definition → synced table → null; notify only on change.
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const R = await import(srcUrl("kernel/registry.ts"));
const def = (id, name) => ({ id, name, defaults: {}, controls: [], Component: () => null });

test("synced table: not in the main registry; isUserCardId and display names; colliding entries ignored; notifies only on change", () => {
  R.resetCards();
  R.registerCards([def("builtin-a", "Built-in A"), def("mine", "Build-time user card")]);
  R.setUserCardSources({ mine: "" }, { mine: "mine" });
  let calls = 0;
  const off = R.onSyncedUserCardsChanged(() => calls++);
  try {
    const gen0 = R.syncedUserCardsGen();
    assert.equal(R.setSyncedUserCards([
      { id: "synced-x", name: "Synced A", source: "src/cards/user/x.tsx" },
      { id: "synced-x", name: "Later duplicate", source: "src/cards/user/x2.tsx" },
      { id: "builtin-a", name: "Collides with built-in", source: "src/cards/user/y.tsx" },
      { id: "mine", name: "Collides with build-time user card", source: "src/cards/user/mine.tsx" },
      { id: "", name: "Empty id" },
    ]), true);
    assert.equal(calls, 1);
    assert.equal(R.syncedUserCardsGen(), gen0 + 1);
    // Does not enter the main registry
    assert.deepEqual(R.allCards().map((c) => c.id).sort(), ["builtin-a", "mine"]);
    assert.equal(R.getCard("synced-x"), undefined);
    // isUserCardId
    assert.equal(R.isUserCardId("synced-x"), true, "Synced user card");
    assert.equal(R.isUserCardId("mine"), true, "Build-time user card");
    assert.equal(R.isUserCardId("builtin-a"), false, "Synced entries that collide with built-in cards are ignored: built-in wins");
    assert.equal(R.isUserCardId("nobody"), false, "Neither side has it");
    assert.equal(R.isUserCardId(undefined), false);
    assert.equal(R.isUserCardId(""), false);
    // Display name
    assert.equal(R.knownCardName("synced-x"), "Synced A", "Multiple entries with the same id: take the first");
    assert.equal(R.knownCardName("mine"), "Build-time user card", "The name defined at build time takes precedence");
    assert.equal(R.knownCardName("builtin-a"), "Built-in A");
    assert.equal(R.knownCardName("nobody"), null, "Unknown card");
    // Setting the same copy again: unchanged, no notification
    assert.equal(R.setSyncedUserCards([{ id: "synced-x", name: "Synced A", source: "src/cards/user/x.tsx" },
      { id: "builtin-a", name: "Collides with built-in", source: "src/cards/user/y.tsx" }, { id: "mine", name: "Collides with build-time user card", source: "src/cards/user/mine.tsx" }]), false);
    assert.equal(calls, 1);
    // Rename: notify
    assert.equal(R.setSyncedUserCards([{ id: "synced-x", name: "Renamed", source: "src/cards/user/x.tsx" }]), true);
    assert.equal(calls, 2);
    assert.equal(R.knownCardName("synced-x"), "Renamed");
    // Clear
    R.setSyncedUserCards([]);
    assert.equal(R.isUserCardId("synced-x"), false);
    assert.equal(R.knownCardName("synced-x"), null);
    assert.equal(R.syncedUserCards().size, 0);
  } finally {
    off();
    R.setSyncedUserCards([]);
    R.setUserCardSources({}, {});
    R.resetCards();
  }
});

test("syncedCardView: read-only view (name, description, defaults, controls; no component); not in the main registry; colliding and unsynced cards return undefined; unchanged returns the same object", () => {
  R.resetCards();
  R.registerCards([def("builtin-a", "Built-in A")]);
  R.setUserCardSources({}, {});
  try {
    const controls = [{ key: "text", label: "Text", type: "text" }, { key: "n", label: "数", type: "number", min: 0, max: 9, step: 1 }];
    R.setSyncedUserCards([
      { id: "s", name: "Synced card", source: "src/cards/user/s.tsx", description: "notes", defaults: { text: "hi", n: 3 }, controls },
      { id: "bare", name: "Name only" },
      { id: "opaque", name: "Controls unrecognized", controls: [], controlsIncomplete: true },
      { id: "builtin-a", name: "Collides with built-in", controls },
    ]);
    const v = R.syncedCardView("s");
    assert.deepEqual({ ...v }, { id: "s", name: "Synced card", description: "notes", defaults: { text: "hi", n: 3 }, controls, controlsIncomplete: false, skippedControls: [], synced: true });
    assert.equal(v.Component, undefined, "No component");
    assert.ok(Object.isFrozen(v), "read-only");
    assert.deepEqual({ ...R.syncedCardView("bare") }, { id: "bare", name: "Name only", defaults: {}, controls: [], controlsIncomplete: false, skippedControls: [], synced: true });
    assert.equal(R.syncedCardView("opaque").controlsIncomplete, true);
    assert.equal(R.syncedCardView("builtin-a"), undefined, "Collides with a built-in card: built-in wins, no view given");
    assert.equal(R.syncedCardView("nobody"), undefined);
    assert.equal(R.syncedCardView(undefined), undefined);
    assert.equal(R.getCard("s"), undefined, "getCard still cannot see it");
    assert.ok(!R.allCards().some((c) => c.id === "s"), "allCards still cannot see it");
    // Setting the same copy again: unchanged, same object; when other cards change,
    // this card's view remains the same object
    assert.equal(R.setSyncedUserCards([
      { id: "s", name: "Synced card", source: "src/cards/user/s.tsx", description: "notes", defaults: { text: "hi", n: 3 }, controls },
      { id: "bare", name: "Name only" }, { id: "opaque", name: "Controls unrecognized", controls: [], controlsIncomplete: true }, { id: "builtin-a", name: "Collides with built-in", controls },
    ]), false);
    assert.equal(R.syncedCardView("s"), v);
    R.setSyncedUserCards([{ id: "s", name: "Synced card", source: "src/cards/user/s.tsx", description: "notes", defaults: { text: "hi", n: 3 }, controls }, { id: "bare", name: "Name changed" }]);
    assert.equal(R.syncedCardView("s"), v, "The view of an unchanged card is not replaced");
    // Control changed: notify, switch to new view
    assert.equal(R.setSyncedUserCards([{ id: "s", name: "Synced card", source: "src/cards/user/s.tsx", description: "notes", defaults: { text: "hi", n: 4 }, controls }]), true);
    assert.notEqual(R.syncedCardView("s"), v);
    assert.equal(R.syncedCardView("s").defaults.n, 4);
    assert.equal(R.syncedCardView("bare"), undefined, "Removed from the table");
  } finally {
    R.setSyncedUserCards([]);
    R.resetCards();
  }
});
