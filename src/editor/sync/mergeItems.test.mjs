/**
 * 冲突合并的逐项引擎(`mergeItems.ts`)。跑:npm test -- src/editor/sync/mergeItems.test.mjs
 *
 * 对着语义(`workflow/editing.md`「撤销、重做」两级列表,`product/document-service.md`「冲突」,2026-10-22 用户定)逐条钉:
 *   MI-01 一级按「东西」分组:每个片段、每条字幕、项目设置各一条;别的片段另起一条
 *   MI-02 二级按属性去重:同一属性改了几次只出一条;先改长度又改透明度是两条;跨批次并表也不重复
 *   MI-03 二级文字写明改成什么、云端现在是什么:「透明度 0.4 → 0.8（云端现在是 0.6）」;冲突按属性各判
 *   MI-04 我删了、别人改了:算冲突;「合并」删掉;「删除选中」保留云端现状
 *   MI-05 我改了、别人删了:算冲突;「合并」连同我的修改恢复;「删除选中」保持删除
 *   MI-06 新增:新片段连带新素材一起并;所在序列、素材都不在时如实失败、留在表里
 *   MI-07 展开后单独勾一项:只并那一项,其余留在表里
 *   MI-08 每次点「合并」重新核对:窗口打开后云端又变了的项报出来
 *   MI-09 勾选:「选中无冲突项」「取消全部勾选」、一级全勾 / 部分 / 没勾
 *   MI-10 字幕逐条:改一条的字、另一条的时间、删一条、加一条,各算一条;合并写回字幕卡的 lines
 *   MI-11 同一序列里放不下(重叠)不硬塞,如实失败
 *   MI-12 留给「撤销冲突」(0.7.20)的来源:source 不同的两条并存,同一套显示与合并
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
  // 第二批:同一属性又改了一次、另加一个属性
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
  // 合并 = 照我这边办:删掉
  const merged = M.applyMerge(cloud, table, all([row]));
  assert.equal(clipIn(merged.project, "c2"), undefined);
  assert.deepEqual(merged.done, [{ key: row.key, props: [""] }]);
  assert.equal(M.removeFromTable(table, merged.done).length, 0);
  // 删除选中 = 只从表里拿掉,云端不动(别人改的透明度还在)
  const left = M.removeFromTable(table, M.selectionList(all([row])));
  assert.equal(left.length, 0);
  assert.equal(clipIn(cloud, "c2").opacity, 0.5);
  // 云端没人改过:同一项不算冲突
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
  // 只勾一项:恢复回来,没勾的按基准
  const one = M.applyMerge(cloud, table, new Map([[row.key, new Set(["opacity"])]]));
  assert.equal(clipIn(one.project, "c3").opacity, 0.7);
  assert.equal(clipIn(one.project, "c3").label, "c3", "an unchecked name follows the base");
  // 删除选中:保持删除
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
  // 序列被别人删了:不硬塞
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
  // 云端别人改了第一句的英文:我的中文照并,英文不动
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
  // 撤销冲突:base = 那一步落地后的值,mine = 撤回后要变成的值
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
  // 用户只挪了 c3(内容末尾 10 → 11):总时长跟着变成 11,但不该冒出一条「项目设置 · 时长」
  const mine = edit(base, (p) => {
    clipIn(p, "c3").start = 9; clipIn(p, "c3").end = 11; p.duration = 11;
    // 系统回填素材元数据、生成卡片声音产物
    Object.assign(p.media[0], { hash: "a".repeat(64), duration: 12, width: 1920, height: 1080, pending: false });
    clipIn(p, "c1").cardAudio = { v: 1, hash: "b".repeat(64) };
    clipIn(p, "c1").embeddedAudio = true;
  });
  const things = M.diffThings(base, mine, meta());
  assert.deepEqual(things.map((t) => t.key), ["offline:clip:c3"], "only the clip the user moved");
  assert.deepEqual(things[0].props.map((p) => p.prop), ["@time"]);
  // 改名照列
  const renamed = M.diffThings(base, edit(base, (p) => { p.media[0].name = "new-name.mp4"; }), meta());
  assert.deepEqual(renamed.map((t) => `${t.key}:${t.props.map((p) => p.prop)}`), ["offline:lib:media:m1:name"]);
  // 合并后总时长按内容末尾重算(不进表、也不留旧值)
  const r = M.applyMerge(base, things, new Map([["offline:clip:c3", new Set(["@time"])]]));
  assert.equal(r.project.duration, 11);
  const truncated = M.applyMerge(base, things, new Map([["offline:clip:c3", new Set(["@time"])]]), { manualDuration: 10.5 });
  assert.equal(truncated.project.duration, 10.5, "a manually truncated duration stays truncated");
});
