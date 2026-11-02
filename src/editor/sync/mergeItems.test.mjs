/**
 * Item-by-item engine for conflict merge (`mergeItems.ts`). Run: npm test -- src/editor/sync/mergeItems.test.mjs
 *
 * Pinned down item-by-item against semantics (`workflow/editing.md` two-level list for "Undo, Redo",
 * `product/document-service.md` "Conflicts", (user decision, 2026-10-22)):
 *   MI-01 Level 1 grouped by "items": one item each for each clip, each caption, and project settings;
 *         other clips start a separate item
 *   MI-02 Level 2 deduplicated by property: modifying same property multiple times yields only one item;
 *         changing duration then opacity yields two items; no duplicates across batches merged into table
 *   MI-03 Level 2 text specifies change target and current cloud state: "opacity 0.4 → 0.8 (cloud is
 *         currently 0.6)"; conflicts evaluated separately per property
 *   MI-04 Deleted by me, modified by others: counts as conflict; "Merge" deletes; "Delete selected"
 *         keeps current cloud state
 *   MI-05 Modified by me, deleted by others: counts as conflict; "Merge" restores along with my changes;
 *         "Delete selected" keeps deleted
 *   MI-06 Additions: new clip merged together with new asset; faithfully fails and remains in table
 *         when target track or asset is absent
 *   MI-07 Check a single item after expanding: merges only that item, others remain in table
 *   MI-08 Re-check each time clicking "Merge": report items that changed in cloud after dialog was opened
 *   MI-09 Checkbox: "Select non-conflicting items", "Deselect all", level 1 all checked / partial / none checked
 *   MI-10 Captions item-by-item: changing text of one, timing of another, deleting one, adding one each
 *         count as one item; merge writes back to lines of captions card
 *   MI-11 When it cannot fit into the same track (overlap), do not force-fit, faithfully fail
 *   MI-12 Sources reserved for "Undo conflict" (0.7.20): two items with different source coexist,
 *         sharing same display and merge
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const M = await import("./mergeItems.ts");

const clip = (id, start, end, extra = {}) => ({ id, cardId: "", start, end, params: {}, label: id, ...extra });
function project(over = {}) {
  return {
    version: 1, id: "p1", name: "Demo", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "dark",
    media: [{ id: "m1", kind: "video", name: "a.mp4", url: "x" }],
    tracks: [
      { id: "t1", name: "Main track", clips: [clip("c1", 0, 2, { opacity: 0.4 }), clip("c2", 3, 5), clip("c3", 6, 8)] },
      { id: "t2", name: "Captions", clips: [{ id: "cap", cardId: "caption-track", start: 0, end: 10, params: { lines: "0.00|1.00|你好|hello\n1.00|2.00|世界|world\n3.00|4.00|再见|bye" } }] },
    ],
    cuts: [{ id: "cutA", name: "Cut 1" }],
    activeCutId: "cutA",
    ...over,
  };
}
const edit = (p, fn) => { const q = structuredClone(p); fn(q); return q; };
const clipIn = (p, id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
const meta = (batch = "b1") => ({ source: "offline", batch, baseRev: 7, at: 1 });
const all = (rows) => new Map(rows.map((r) => [r.key, new Set(r.props.map((x) => x.prop))]));

test("MI-01 level one is grouped by item: one entry for each clip, each caption line, and the project settings", () => {
  const base = project();
  const mine = edit(base, (p) => {
    clipIn(p, "c1").opacity = 0.8;
    clipIn(p, "c2").end = 6;
    p.fps = 25;
    p.tracks[1].clips[0].params.lines = "0.00|1.00|你好呀|hello\n1.00|2.00|世界|world\n3.00|4.00|再见|bye";
  });
  const things = M.diffThings(base, mine, meta());
  const labels = things.map((t) => t.label).sort();
  assert.deepEqual(labels, ['Captions "你好呀"', 'Clip "c1 @0.0s"', 'Clip "c2 @3.0s"', "Project settings"].sort());
  const keys = things.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, "one entry per item");
  assert.ok(!things.some((t) => t.key === "offline:clip:cap"), "a caption card with one caption line edited does not also list the whole caption card");
});

test("MI-02 level two is deduplicated by property: changing the same property twice gives only one entry; changing the length and then the opacity gives two; merging batches into the table does not create duplicates", () => {
  const base = project();
  const mid = edit(base, (p) => { clipIn(p, "c1").opacity = 0.6; });
  const mine = edit(mid, (p) => { clipIn(p, "c1").opacity = 0.8; clipIn(p, "c1").end = 3; });
  const [t] = M.diffThings(base, mine, meta());
  assert.deepEqual(t.props.map((x) => x.prop).sort(), ["@time", "opacity"]);
  assert.deepEqual(t.props.find((x) => x.prop === "opacity"), { prop: "opacity", base: { v: 0.4 }, mine: { v: 0.8 } }, "opacity changed twice: record only the base → the final value");
  // Second batch: same property modified once more, plus an additional property
  const later = edit(base, (p) => { clipIn(p, "c1").opacity = 0.9; clipIn(p, "c1").fadeIn = 0.5; });
  const table = M.mergeIntoTable([t], M.diffThings(base, later, meta("b2")));
  assert.equal(table.length, 1, "the same item still gets one entry");
  assert.deepEqual(table[0].props.map((x) => x.prop).sort(), ["@time", "fadeIn", "opacity"]);
  assert.deepEqual(table[0].props.find((x) => x.prop === "opacity").mine, { v: 0.9 });
});

test("MI-03 level-two text states what it was changed to and what the cloud is now; conflicts are judged per property", () => {
  const base = project();
  const mine = edit(base, (p) => { clipIn(p, "c1").opacity = 0.8; clipIn(p, "c1").end = 3; });
  const cloud = edit(base, (p) => { clipIn(p, "c1").opacity = 0.6; });
  const table = M.diffThings(base, mine, meta());
  const [row] = M.mergeRows(cloud, table);
  const op = row.props.find((x) => x.prop === "opacity");
  assert.equal(op.text, "Opacity 0.4 → 0.8 (The cloud is now 0.6)");
  assert.equal(op.conflict, true);
  const time = row.props.find((x) => x.prop === "@time");
  assert.equal(time.text, "Time 0–2 s → 0–3 s (The cloud is now 0–2 s)");
  assert.equal(time.conflict, false, "length: nobody touched it in the cloud, no conflict");
  assert.equal(row.conflict, true, "level one: if any entry conflicts, mark it as conflicting");
  assert.deepEqual(M.mergeCounts([row]), { total: 1, conflicts: 1, items: 2 }, "the bar counts by level one (one place per item), level two is counted separately");
});

test("MI-04 I deleted it, someone else changed it: conflict; \"Merge\" deletes it; \"Delete selected\" keeps the cloud as it is now", () => {
  const base = project();
  const mine = edit(base, (p) => { p.tracks[0].clips = p.tracks[0].clips.filter((c) => c.id !== "c2"); });
  const cloud = edit(base, (p) => { clipIn(p, "c2").opacity = 0.5; });
  const table = M.diffThings(base, mine, meta());
  assert.equal(table.length, 1);
  assert.equal(table[0].change, "delete");
  const [row] = M.mergeRows(cloud, table);
  assert.equal(row.conflict, true);
  assert.equal(row.props[0].text, "Deleted on my side (the cloud version has since been changed by someone else)");
  // Merge = follow my side: delete
  const merged = M.applyMerge(cloud, table, all([row]));
  assert.equal(clipIn(merged.project, "c2"), undefined);
  assert.deepEqual(merged.done, [{ key: row.key, props: [""] }]);
  assert.equal(M.removeFromTable(table, merged.done).length, 0);
  // Delete selected = only remove from table, cloud untouched (opacity modified by others remains)
  const left = M.removeFromTable(table, M.selectionList(all([row])));
  assert.equal(left.length, 0);
  assert.equal(clipIn(cloud, "c2").opacity, 0.5);
  // Untouched by anyone in cloud: same item does not count as conflict
  const [clean] = M.mergeRows(base, table);
  assert.equal(clean.conflict, false);
});

test("MI-05 I changed it, someone else deleted it: conflict; \"Merge\" restores it together with my edits; \"Delete selected\" keeps it deleted", () => {
  const base = project();
  const mine = edit(base, (p) => { clipIn(p, "c3").opacity = 0.7; clipIn(p, "c3").label = "Outro"; });
  const cloud = edit(base, (p) => { p.tracks[0].clips = p.tracks[0].clips.filter((c) => c.id !== "c3"); });
  const table = M.diffThings(base, mine, meta());
  const [row] = M.mergeRows(cloud, table);
  assert.equal(row.changeText, "Deleted in the cloud");
  assert.ok(row.props.every((x) => x.conflict && x.text.endsWith(" (Deleted in the cloud)")), JSON.stringify(row.props));
  const merged = M.applyMerge(cloud, table, all([row]));
  const back = clipIn(merged.project, "c3");
  assert.equal(back.opacity, 0.7);
  assert.equal(back.label, "Outro");
  assert.deepEqual([back.start, back.end], [6, 8]);
  // Only check one item: restored, unchecked items follow baseline
  const one = M.applyMerge(cloud, table, new Map([[row.key, new Set(["opacity"])]]));
  assert.equal(clipIn(one.project, "c3").opacity, 0.7);
  assert.equal(clipIn(one.project, "c3").label, "c3", "an unchecked name follows the base");
  // Delete selected: keep deleted
  assert.equal(M.removeFromTable(table, M.selectionList(all([row]))).length, 0);
  assert.equal(clipIn(cloud, "c3"), undefined);
});

test("MI-06 additions: a new clip is merged together with its new media; when the track it belongs to is missing, it fails honestly and stays in the table", () => {
  const base = project();
  const mine = edit(base, (p) => {
    p.media.push({ id: "m2", kind: "image", name: "b.png", url: "y" });
    p.tracks[0].clips.push(clip("c9", 10, 12, { mediaId: "m2" }));
  });
  const table = M.diffThings(base, mine, meta());
  assert.deepEqual(table.map((t) => [t.ref.kind, t.change]).sort(), [["clip", "add"], ["library", "add"]]);
  const rows = M.mergeRows(base, table);
  const clipRow = rows.find((r) => r.key === "offline:clip:c9");
  const r = M.applyMerge(base, table, new Map([[clipRow.key, new Set([""])]]));
  assert.ok(clipIn(r.project, "c9"));
  assert.ok(r.project.media.some((m) => m.id === "m2"), "the media is merged in along with it");
  assert.equal(M.removeFromTable(table, r.done).length, 0, "the associated media is also removed from the table");
  // Track was deleted by others: do not force-fit
  const noTrack = edit(base, (p) => { p.tracks = p.tracks.filter((t) => t.id !== "t1"); });
  const f = M.applyMerge(noTrack, table, new Map([[clipRow.key, new Set([""])]]));
  assert.deepEqual(f.failed.map((x) => x.reason), ["Its track no longer exists in the cloud"]);
  assert.equal(M.removeFromTable(table, f.done).length, 1, "the failed one stays in the table (its media was merged and is removed)");
});

test("MI-07 after expanding, check a single entry: only that one is merged, the rest stay in the table", () => {
  const base = project();
  const mine = edit(base, (p) => { clipIn(p, "c1").opacity = 0.8; clipIn(p, "c1").fadeIn = 0.3; });
  const table = M.diffThings(base, mine, meta());
  const r = M.applyMerge(base, table, new Map([[table[0].key, new Set(["fadeIn"])]]));
  assert.equal(clipIn(r.project, "c1").fadeIn, 0.3);
  assert.equal(clipIn(r.project, "c1").opacity, 0.4, "an unchecked opacity is left alone");
  const left = M.removeFromTable(table, r.done);
  assert.deepEqual(left[0].props.map((x) => x.prop), ["opacity"]);
  assert.notEqual(r.project, base, "returns a new object");
  assert.equal(clipIn(base, "c1").fadeIn, undefined, "The input argument is not modified");
});

test("MI-08 re-check on every click of Merge: entries that changed again in the cloud after the window was opened are reported", () => {
  const base = project();
  const mine = edit(base, (p) => { clipIn(p, "c1").opacity = 0.8; clipIn(p, "c2").opacity = 0.2; });
  const table = M.diffThings(base, mine, meta());
  const rows = M.mergeRows(base, table);
  const seen = new Map(rows.flatMap((r) => r.props.map((x) => [x.id, x.cloud])));
  const later = edit(base, (p) => { clipIn(p, "c1").opacity = 0.5; });
  const stale = M.staleSelections(later, table, seen, all(rows));
  assert.deepEqual(stale, ["offline:clip:c1|opacity"]);
});

test("MI-09 checking: select non-conflicting entries, uncheck all, level one fully checked / partially checked / unchecked", () => {
  const base = project();
  const mine = edit(base, (p) => { clipIn(p, "c1").opacity = 0.8; clipIn(p, "c1").end = 3; clipIn(p, "c2").opacity = 0.2; });
  const cloud = edit(base, (p) => { clipIn(p, "c1").opacity = 0.6; });
  const rows = M.mergeRows(cloud, M.diffThings(base, mine, meta()));
  const sel = M.selectNonConflict(rows);
  assert.equal(M.selectedCount(rows, sel), 2, "c1's length + c2's opacity");
  const c1 = rows.find((r) => r.key === "offline:clip:c1");
  assert.equal(M.thingCheck(c1, sel), "some");
  assert.equal(M.thingCheck(rows.find((r) => r.key === "offline:clip:c2"), sel), "all");
  const full = M.toggleThing(c1, sel);
  assert.equal(M.thingCheck(c1, full), "all");
  assert.equal(M.thingCheck(c1, M.toggleThing(c1, full)), "none");
  assert.equal(M.thingCheck(c1, M.toggleProp(c1, "opacity", sel)), "all");
  assert.equal(M.selectedCount(rows, new Map()), 0, "uncheck all = empty selection");
});

test("MI-10 captions line by line: editing the text, editing the timing, deleting a line, and adding a line each count as one entry; merging writes back to lines", () => {
  const base = project();
  const mine = edit(base, (p) => {
    p.tracks[1].clips[0].params.lines = "0.00|1.00|你好呀|hello\n1.00|2.50|世界|world\n5.00|6.00|新的一句|new";
  });
  const table = M.diffThings(base, mine, meta());
  const kinds = table.map((t) => `${t.change}:${t.label}`).sort();
  assert.deepEqual(kinds, ['add:Captions "新的一句"', 'delete:Captions "再见"', 'modify:Captions "你好呀"', 'modify:Captions "世界"'].sort());
  const world = table.find((t) => t.label === 'Captions "世界"');
  assert.deepEqual(world.props.map((x) => x.prop), ["time"]);
  // Someone else modified English of the first sentence in cloud: my Chinese merges as usual, English untouched
  const cloud = edit(base, (p) => { p.tracks[1].clips[0].params.lines = "0.00|1.00|你好|hi\n1.00|2.00|世界|world\n3.00|4.00|再见|bye"; });
  const rows = M.mergeRows(cloud, table);
  const hello = rows.find((r) => r.label === 'Captions "你好呀"');
  assert.equal(hello.props[0].text, 'Chinese "你好" → "你好呀" (The cloud is now "你好")');
  assert.equal(hello.conflict, false);
  const r = M.applyMerge(cloud, table, all(rows));
  assert.equal(clipIn(r.project, "cap").params.lines, "0.00|1.00|你好呀|hi\n1.00|2.50|世界|world\n5.00|6.00|新的一句|new");
  assert.equal(r.failed.length, 0);
});

test("MI-11 when it doesn't fit in the same track (overlap), don't force it in; fail honestly", () => {
  const base = project();
  const mine = edit(base, (p) => { clipIn(p, "c1").end = 2.5; });
  const cloud = edit(base, (p) => { clipIn(p, "c2").start = 2.2; });
  const table = M.diffThings(base, mine, meta());
  const r = M.applyMerge(cloud, table, all(M.mergeRows(cloud, table)));
  assert.deepEqual(r.failed.map((x) => x.reason), ["Overlaps a clip in the same track"]);
  assert.equal(clipIn(r.project, "c1").end, 2);
});

test("MI-12 undo conflicts (0.7.20) use the same shape: two entries from different sources coexist, with the same display and merge", () => {
  const base = project();
  const off = M.diffThings(base, edit(base, (p) => { clipIn(p, "c1").opacity = 0.8; }), meta());
  // Undo conflict: base = value after that step landed, mine = value to become after undoing
  const undo = M.diffThings(edit(base, (p) => { clipIn(p, "c2").label = "Edited by Agent"; }), base, { source: "undo", batch: "u1", baseRev: 9, at: 2 });
  const table = M.mergeIntoTable(off, undo);
  assert.deepEqual(table.map((t) => t.key).sort(), ["offline:clip:c1", "undo:clip:c2"]);
  const cloud = edit(base, (p) => { clipIn(p, "c2").label = "Edited by Agent"; });
  const rows = M.mergeRows(cloud, table);
  assert.equal(rows.find((r) => r.source === "undo").props[0].text, 'Name "Edited by Agent" → "c2" (The cloud is now "Edited by Agent")');
  const r = M.applyMerge(cloud, table, all(rows));
  assert.equal(clipIn(r.project, "c2").label, "c2");
  assert.equal(clipIn(r.project, "c1").opacity, 0.8);
});

test("MI-13 card source: one entry per card, level two is \"Source\"; counts as a conflict as a whole; merging does not go through the project JSON but is handed to card source sync", () => {
  const base = project();
  const thing = M.cardConflictThing({ key: "src/cards/user/price-tag.tsx", mine: "a\nb\nmine\n", cloud: "a\nb\ncloud1\ncloud2\n", rev: 5, at: 1, batch: "c1" });
  assert.equal(thing.key, "offline:card:src/cards/user/price-tag.tsx");
  const offline = M.diffThings(base, edit(base, (p) => { clipIn(p, "c1").opacity = 0.8; }), meta());
  const table = M.mergeIntoTable(offline, [thing]);
  const rows = M.mergeRows(base, table);
  const card = rows.find((r) => r.key === thing.key);
  assert.equal(card.label, 'Card source "cards/user/price-tag.tsx"');
  assert.deepEqual(card.props.map((p) => p.label), ["Source code"]);
  assert.equal(card.props[0].text, "Source: my version has 1 more lines and 2 fewer lines than the cloud's current version (the cloud version was edited by someone else)");
  assert.equal(card.conflict, true, "the cloud was also changed by someone else: counts as a conflict as a whole");
  assert.equal(M.selectNonConflict(rows).has(thing.key), false, "selecting non-conflicting entries does not check it");
  const r = M.applyMerge(base, table, M.selectNonConflict(rows, new Map([[thing.key, new Set(["source"])]])));
  assert.deepEqual(r.external.map((x) => x.key), [thing.key], "handed to card source sync to write back");
  assert.equal(r.done.some((d) => d.key === thing.key), false, "not removed from the table until the write succeeds");
  assert.equal(clipIn(r.project, "c1").opacity, 0.8, "entries inside the project are written as usual in the same merge");
  assert.deepEqual(M.lineDelta("x\ny", "x\ny"), { added: 0, removed: 0 });
});

test("MI-14 [ruling] list only what the user changed directly: derived values such as total duration, media metadata backfill, and card sound output do not enter the table; after merging, the total duration is recomputed from the content", () => {
  const base = project({ duration: 10 });
  // User only moved c3 (content end 10 → 11): total duration becomes 11 accordingly, but a
  // "Project settings · Duration" item should not pop up
  const mine = edit(base, (p) => {
    clipIn(p, "c3").start = 9; clipIn(p, "c3").end = 11; p.duration = 11;
    // System backfills asset metadata, generates card sound artifacts
    Object.assign(p.media[0], { hash: "a".repeat(64), duration: 12, width: 1920, height: 1080, pending: false });
    clipIn(p, "c1").cardAudio = { v: 1, hash: "b".repeat(64) };
    clipIn(p, "c1").embeddedAudio = true;
  });
  const things = M.diffThings(base, mine, meta());
  assert.deepEqual(things.map((t) => t.key), ["offline:clip:c3"], "only the clip the user moved");
  assert.deepEqual(things[0].props.map((p) => p.prop), ["@time"]);
  // Renaming listed as usual
  const renamed = M.diffThings(base, edit(base, (p) => { p.media[0].name = "new-name.mp4"; }), meta());
  assert.deepEqual(renamed.map((t) => `${t.key}:${t.props.map((p) => p.prop)}`), ["offline:lib:media:m1:name"]);
  // After merge, total duration is recalculated from content end (does not enter table, old value not retained)
  const r = M.applyMerge(base, things, new Map([["offline:clip:c3", new Set(["@time"])]]));
  assert.equal(r.project.duration, 11);
  const truncated = M.applyMerge(base, things, new Map([["offline:clip:c3", new Set(["@time"])]]), { manualDuration: 10.5 });
  assert.equal(truncated.project.duration, 10.5, "a manually truncated duration stays truncated");
});
