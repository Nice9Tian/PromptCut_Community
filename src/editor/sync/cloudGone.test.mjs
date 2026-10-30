/**
 * 过期的云端项目转成本地项目(`cloudGone.ts`)与它的出处记录、转换通知(`recoveryAssociation.ts`)。
 * 对应 `docs/plan/account-binding-task.md`「逐项验收」的「过期云端项目转本地」一行里不需要页面的部分。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { convertGoneProject } = await import(srcUrl("editor/sync/cloudGone.ts"));
const R = await import(srcUrl("editor/sync/recoveryAssociation.ts"));

const room = `sp_${"a".repeat(26)}`;
const descriptor = { version: 1, roomId: room, service: "https://old-hosted.example/hosted", where: "hosted" };
const proof = { v: 1, authorityId: "doc", projectId: room, state: "gone", tombstoneRevision: 7, issuedAt: 5, kid: "k1", signature: "s" };
const project = () => ({
  id: "old-content-id", name: "旧云端项目", duration: 12, fps: 30, width: 1920, height: 1080,
  media: [{ id: "m1", kind: "video", name: "a.mp4", url: `/@media/${"b".repeat(64)}`, hash: "b".repeat(64), path: "C:/x/a.mp4" }],
  tracks: [{ id: "t1", clips: [{ id: "c1", mediaId: "m1", start: 1, end: 4, mediaOffset: 2, opacity: 0.5, audioVolume: 0.3, fadeIn: 0.2, params: { k: [1, 2] } }] }],
  cardNodes: [{ id: "n1", adapter: "card", cardId: "user-card", params: { title: "原样" } }], cuts: [{ id: "cut" }], extra: { kept: true },
});

test("内容原样保留、换新的本地项目号、不带任何协作关联", () => {
  const source = project(); const frozen = JSON.stringify(source);
  const out = convertGoneProject(source, descriptor, proof, { newId: () => "new-local-id", now: () => new Date("2026-10-13T08:00:00Z") });
  assert.equal(out.project.id, "new-local-id");
  assert.notEqual(out.project, source, "换新对象,不原地改");
  assert.equal(JSON.stringify(source), frozen, "入参没被改");
  const { id: _a, ...after } = out.project; const { id: _b, ...before } = source;
  assert.deepEqual(after, before, "除项目号外逐字段相同:序列、片段位置与参数、素材表、卡片节点、剪辑、不认识的字段");
  assert.equal(out.project.media, source.media, "素材表原样(哈希、路径、名字都在,缺不缺由后台检查判)");
  assert.deepEqual(out.from, { v: 1, roomId: room, service: descriptor.service, authorityId: "doc", tombstoneRevision: 7, kid: "k1", convertedAt: "2026-10-13T08:00:00.000Z" });
  assert.equal(JSON.stringify(out).includes("signature"), false, "出处记录不带证明的签名,也没有任何凭证");
  const again = convertGoneProject(source, descriptor, proof);
  assert.notEqual(again.project.id, "old-content-id"); assert.match(again.project.id, /\S/);
});

test("证明与项目对不上、不是云端项目、内容不可读:不转", () => {
  assert.throws(() => convertGoneProject(project(), descriptor, { ...proof, projectId: `sp_${"c".repeat(26)}` }), /对不上/);
  assert.throws(() => convertGoneProject(project(), descriptor, { ...proof, state: "exists" }), /对不上/);
  assert.throws(() => convertGoneProject(project(), descriptor, null), /对不上/);
  assert.throws(() => convertGoneProject(project(), { ...descriptor, where: "lan" }, proof), /云端项目/);
  assert.throws(() => convertGoneProject(project(), { version: 2, roomId: room, service: descriptor.service, where: "hosted" }, proof), /云端项目/);
  assert.throws(() => convertGoneProject({ id: "x" }, descriptor, proof), /不可读/);
  assert.throws(() => convertGoneProject(null, descriptor, proof), /不可读/);
});

test("出处记录:形状不对的不收;只跟着那一个项目号;转换通知每条只取一次", () => {
  const from = { v: 1, roomId: room, service: descriptor.service, authorityId: "doc", tombstoneRevision: 7, kid: "k1", convertedAt: "2026-10-13T08:00:00.000Z" };
  assert.deepEqual(R.parseConvertedFrom({ ...from, accessToken: "never-kept" }), from, "只留认识的字段");
  for (const bad of [null, "x", { ...from, v: 2 }, { ...from, roomId: "nope" }, { ...from, tombstoneRevision: "7" }, { ...from, service: 5 }]) assert.equal(R.parseConvertedFrom(bad), null);
  R.noteConvertedFrom({ id: "p1" }, from);
  assert.deepEqual(R.convertedFromOf({ id: "p1" }), from);
  assert.equal(R.convertedFromOf({ id: "p2" }), null, "换了别的项目不带过去");
  R.noteConvertedFrom({ id: "p3" }, undefined);
  assert.equal(R.convertedFromOf({ id: "p1" }), null, "载入一个没有出处的文件后清掉");

  const seen = [];
  const off = R.onGoneConversion((e) => seen.push(e.projectId));
  const offBad = R.onGoneConversion(() => { throw new Error("一个订阅者出错"); });
  R.publishGoneConversion({ projectId: "p1", name: "n", from });
  assert.deepEqual(seen, ["p1"], "别的订阅者照常收到");
  assert.deepEqual(R.takeGoneNotices().map((e) => e.projectId), ["p1"]);
  assert.deepEqual(R.takeGoneNotices(), [], "提示一次");
  off(); offBad(); R.publishGoneConversion({ projectId: "p4", name: "n", from });
  assert.deepEqual(seen, ["p1"]); R.takeGoneNotices();
});

test("转换后的关联:当前关联清空,保存出去的文件不再带旧云端", () => {
  R.setAssociation(descriptor, true);
  assert.equal(R.isRecoveringAssociation(), true);
  R.setAssociation(null);
  assert.equal(R.currentAssociation(), null); assert.equal(R.isRecoveringAssociation(), false);
});

/* ---------------- 转换之前并入这台设备上没发出去的离线修改 ---------------- */

const { restoreOfflineEdits } = await import(srcUrl("editor/sync/cloudGone.ts"));
const { DocSync } = await import(srcUrl("store/docsync.ts"));
const { createEmptyProject } = await import(srcUrl("kernel/project.ts"));
const docCopy = (initial) => new DocSync(initial, { projectId: room, session: "gone-test", initialize: false, send: () => {}, saveBackup: () => {} });

test("离线改过、没另存:转换后的本地项目里有这些修改", async () => {
  // 上一次打开:连着云端时断了线,离线改了名字和时长,记进本机的恢复数据
  const file = { ...createEmptyProject("文件里的名字"), id: "old-content-id" };
  const before = docCopy(file); before.connect(); before.receive({ type: "project.state", projectId: room, project: file, rev: 4 }); before.disconnect();
  before.commit({ ...before.project, name: "离线改的名字", duration: 42 });
  const journal = JSON.parse(JSON.stringify(before.recoveryJournal()));
  // 这一次打开:云端项目已被清掉,一上来就拿到了证明,这时手上只有文件内容
  const kept = { ds: docCopy(file), restored: false };
  assert.equal(kept.ds.project.name, "文件里的名字");
  let reads = 0;
  const how = await restoreOfflineEdits({ restored: kept.restored, readJournal: async () => { reads++; return journal; }, restoreJournal: (j) => kept.ds.restoreJournal(j) });
  assert.equal(how, "restored"); assert.equal(reads, 1);
  const out = convertGoneProject(kept.ds.project, descriptor, proof, { newId: () => "new-local-id" });
  assert.equal(out.project.name, "离线改的名字"); assert.equal(out.project.duration, 42); assert.equal(out.project.id, "new-local-id");
  // 不先并进来的话(改之前的做法)拿到的只是文件内容
  assert.equal(convertGoneProject(docCopy(file).project, descriptor, proof).project.name, "文件里的名字");
});

test("离线修改读不出来或记录损坏:不转;已经恢复过、本来就没有离线修改:照常转", async () => {
  const file = { ...createEmptyProject("文件里的名字"), id: "old-content-id" };
  const kept = { ds: docCopy(file) };
  await assert.rejects(() => restoreOfflineEdits({ restored: false, readJournal: async () => { throw new Error("vault busy"); }, restoreJournal: () => assert.fail("不该走到这里") }),
    (e) => e.reason === "offline-edits-unreadable");
  await assert.rejects(() => restoreOfflineEdits({ restored: false, readJournal: async () => ({ version: 9, garbage: true }), restoreJournal: (j) => kept.ds.restoreJournal(j) }),
    (e) => e.reason === "offline-edits-damaged");
  assert.equal(kept.ds.project.name, "文件里的名字", "损坏的记录没有改动手上的内容");
  assert.equal(await restoreOfflineEdits({ restored: true, readJournal: async () => assert.fail("已经恢复过就不再读"), restoreJournal: () => assert.fail("也不再并") }), "already");
  let restored = 0;
  assert.equal(await restoreOfflineEdits({ restored: false, readJournal: async () => null, restoreJournal: () => { restored++; } }), "none");
  assert.equal(restored, 0);
});
