/**
 * 固定非本机快照(`cloudSnapshot.ts`、`io/proc.ts` 的另存、`recoveryAssociation.ts` 的读回)。
 * 跑:npm test -- src/editor/sync/cloudSnapshot.test.mjs
 *
 *   CS-01 同步 SHA-256 对得上标准向量
 *   CS-02 另存:连着这个云端项目时记下当下确认过的那一版(基准内容、哈希、序号);没连着时沿用文件里原来的基准与序号
 *   CS-03 读回:老文件没有基准照旧能开;哈希对不上(被改坏)当没有基准
 *   CS-04 坏情形:另存 → 本机改 → 云端另有人改 → 重开连回:别人的改动不被当成「我撤销的」,只列我的修改;合并后别人的改动还在
 *   CS-05 云端没人动过:直接提交;本机没改过:什么都不做
 *   CS-06 .proc 真的另存、读回:带基准与哈希,哈希核得上;老格式的 .proc(没有这一段)读回能开、走老办法;记下文件变大多少
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const S = await import(srcUrl("editor/sync/cloudSnapshot.ts"));
const { sha256Hex } = await import(srcUrl("editor/sync/sha256.ts"));
const M = await import(srcUrl("editor/sync/mergeItems.ts"));

const clip = (id, start, end, extra = {}) => ({ id, cardId: "", start, end, params: {}, label: id, ...extra });
const project = () => ({
  version: 1, id: "p-cloud", name: "云端项目", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "dark", media: [],
  tracks: [{ id: "t1", name: "主序列", clips: [clip("c1", 0, 2, { opacity: 0.4 }), clip("c2", 3, 5), clip("c3", 6, 8)] }],
});
const edit = (p, fn) => { const q = structuredClone(p); fn(q); return q; };
const clipIn = (p, id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
const meta = { batch: "b1", at: 1 };

test("CS-01 同步 SHA-256 对得上标准向量", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const long = JSON.stringify(project()).repeat(37) + "中文";
  assert.equal(sha256Hex(long), createHash("sha256").update(long, "utf8").digest("hex"));
});

test("CS-02 另存:连着时记当下确认过的那一版;没连着时沿用原来的基准与序号", () => {
  const base = project();
  const live = S.snapshotForSave({ savedRev: 3 }, { rev: 7, project: base }, new Date(0));
  assert.equal(live.savedRev, 7);
  assert.equal(live.savedAt, new Date(0).toISOString());
  assert.deepEqual(live.base, base);
  assert.equal(live.baseSha256, sha256Hex(JSON.stringify(base)));
  const offline = S.snapshotForSave({ savedRev: 7, base, baseSha256: live.baseSha256 }, null);
  assert.equal(offline.savedRev, 7, "以本地副本打开再另存:序号不变");
  assert.deepEqual(offline.base, base, "基准不变(仍是本机改之前云端的样子)");
  const legacy = S.snapshotForSave({ savedRev: 4 }, null);
  assert.equal("base" in legacy, false, "老文件再另存、又没连着:没有基准就不编一个");
});

test("CS-03 读回:老文件没有基准照旧;哈希对不上当没有", () => {
  const base = project();
  assert.equal(S.verifiedBase({}), null);
  assert.equal(S.verifiedBase({ base, baseSha256: S.snapshotHash(base) }) !== null, true);
  assert.equal(S.verifiedBase({ base: edit(base, (p) => { p.name = "被改过"; }), baseSha256: S.snapshotHash(base) }), null);
  assert.equal(S.verifiedBase({ base: { not: "a project" }, baseSha256: "x" }), null);
});

test("CS-04 坏情形:另存 → 本机改 → 云端另有人改 → 重开:别人的改动不被当成我撤销的", () => {
  const base = project();                                                        // 另存那一刻(rev 7)
  const file = edit(base, (p) => { clipIn(p, "c1").opacity = 0.9; });            // 本机在文件里改了 c1
  const cloud = edit(base, (p) => { clipIn(p, "c2").label = "别人改的"; p.tracks[0].clips.push(clip("c9", 9, 9.5)); }); // 云端:别人改 c2、加 c9(rev 8)
  const assoc = { savedRev: 7, base, baseSha256: S.snapshotHash(base) };
  const plan = S.reopenPlan(assoc, file, 8, meta);
  assert.equal(plan.kind, "table");
  assert.deepEqual(plan.things.map((t) => t.key), ["offline:clip:c1"], "只列我的修改,没有「c2 改回去」「删掉 c9」");
  const rows = M.mergeRows(cloud, plan.things);
  assert.equal(rows[0].props[0].text, "透明度 0.4 → 0.9（云端现在是 0.4）");
  const r = M.applyMerge(cloud, plan.things, new Map([["offline:clip:c1", new Set(["opacity"])]]));
  assert.equal(clipIn(r.project, "c1").opacity, 0.9);
  assert.equal(clipIn(r.project, "c2").label, "别人改的", "别人的改动还在");
  assert.ok(clipIn(r.project, "c9"), "别人加的片段还在");
  // 对照:没有基准时(老办法,以连回时的云端为基准)会把别人的改动当成我撤销的
  const legacy = M.diffThings(cloud, file, { source: "offline", batch: "x", baseRev: 8, at: 1 }).map((t) => t.key).sort();
  assert.deepEqual(legacy, ["offline:clip:c1", "offline:clip:c2", "offline:clip:c9"], "老办法的错:c2 改回去、c9 删掉");
});

test("CS-05 云端没人动过:直接提交;本机没改过:什么都不做;老文件:老办法", () => {
  const base = project();
  const assoc = { savedRev: 7, base, baseSha256: S.snapshotHash(base) };
  const file = edit(base, (p) => { clipIn(p, "c1").opacity = 0.9; });
  assert.equal(S.reopenPlan(assoc, file, 7, meta).kind, "commit");
  assert.equal(S.reopenPlan(assoc, structuredClone(base), 9, meta).kind, "none");
  assert.equal(S.reopenPlan({ savedRev: 7 }, file, 9, meta).kind, "legacy");
});

test("CS-06 .proc 另存带基准与哈希、读回核得上;老格式的 .proc 照旧能开;文件变大多少", async () => {
  const { serializeProc, loadProc } = await import(srcUrl("editor/io/proc.ts"));
  const R = await import(srcUrl("editor/sync/recoveryAssociation.ts"));
  const base = project();
  const assoc = { accountProject: true, projectId: "proj-cloud-cs", docServiceUrl: "https://example.invalid/hosted", origin: "https://example.invalid", savedRev: 3, savedAt: new Date(0).toISOString() };
  R.setCloudAssociation(assoc);
  R.setCloudSnapshotGetter((projectId) => (projectId === "proj-cloud-cs" ? { rev: 7, project: base } : null));
  try {
    const text = serializeProc();
    const doc = JSON.parse(text);
    assert.equal(doc.cloudAssociation.savedRev, 7);
    assert.deepEqual(doc.cloudAssociation.base, base);
    assert.equal(doc.cloudAssociation.baseSha256, sha256Hex(JSON.stringify(base)));
    const loaded = loadProc(text);
    const back = R.takeLoadedCloudAssociation(loaded);
    assert.deepEqual(back.base, base, "读回带基准");
    assert.equal(S.reopenPlan(back, edit(base, (p) => { clipIn(p, "c1").opacity = 0.9; }), 8, meta).kind, "table");
    // 文件变大多少:基准是项目内容再多一份(不含素材字节、快照、卡片源码)
    const without = JSON.parse(text); delete without.cloudAssociation.base; delete without.cloudAssociation.baseSha256;
    const grow = text.length - JSON.stringify(without, null, 2).length;
    console.log(`CS-06 另存文件:${text.length} 字符,其中基准 ${grow} 字符(项目内容 JSON ${JSON.stringify(doc.project).length} 字符)`);
    assert.ok(grow > 0);
    // 老格式:没有 base / baseSha256
    const old = JSON.parse(text); delete old.cloudAssociation.base; delete old.cloudAssociation.baseSha256;
    const oldLoaded = loadProc(JSON.stringify(old));
    const oldAssoc = R.takeLoadedCloudAssociation(oldLoaded);
    assert.equal(oldAssoc.projectId, "proj-cloud-cs", "老文件照旧打开、关联照旧");
    assert.equal(oldAssoc.base, undefined);
    assert.equal(S.reopenPlan(oldAssoc, edit(base, (p) => { clipIn(p, "c1").opacity = 0.9; }), 9, meta).kind, "legacy");
    // 基准被改坏:当没有,照旧打开
    const bad = JSON.parse(text); bad.cloudAssociation.base.name = "被改过";
    const badAssoc = R.takeLoadedCloudAssociation(loadProc(JSON.stringify(bad)));
    assert.equal(badAssoc.base, undefined);
  } finally {
    R.setCloudAssociation(null);
    R.setCloudSnapshotGetter(null);
  }
});
