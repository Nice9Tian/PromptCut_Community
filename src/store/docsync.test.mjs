/**
 * docsync(页面到文档服务的同步层)的测试。跑:node --test src/store/docsync.test.mjs
 *
 * 用 src/testing/memDocService.mjs 的内存文档服务假件,消息随机交错投递。钉的是 c65-design.md:
 *   V2:两个页面各 200 次随机编辑交错提交,两边与文档服务三份逐字节相同;
 *   V5:撤销不盖别人(这一步之后被别的写入身份改过的实体不撤);
 *   V6:离线队列(按顺序落地;第一条被拒整批停下,「重放」「丢弃」);
 *   V7:.proc 只在所有本地操作确认后写(whenSettled);
 *   V8:1000 个片段的项目,提交一侧的差异计算 ≤ 5 ms。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { MemDocService } from "../testing/memDocService.mjs";
import { rng, randProject, mutateOnce, realisticEdit, bigProject } from "../testing/randomProject.mjs";

const { DocSync } = await import(srcUrl("store/docsync.ts"));

const json = (v) => JSON.stringify(v);

/** 一个页面:DocSync + 接到假件上的连接 */
function page(svc, session, initial, extra = {}) {
  const sent = [];
  const backups = [];
  const notices = [];
  let link = null;
  const ds = new DocSync(initial, {
    projectId: "P",
    session,
    send: (msg) => {
      sent.push(msg);
      link?.send(msg);
    },
    saveBackup: (b) => backups.push(b),
    ...extra,
  });
  ds.on("notice", (n) => notices.push(n));
  const up = () => {
    link = svc.connect(session, (msg) => ds.receive(msg));
    ds.connect();
  };
  const down = (opts) => {
    if (link) svc.disconnect(link.conn, opts);
    link = null;
    ds.disconnect();
  };
  up();
  return { ds, sent, backups, notices, up, down, get conn() { return link?.conn; } };
}

/** 本地做一次随机修改,交给 docsync。chaos:整份深拷贝后在任意位置乱改(换类型、删键、重复 id…) */
function randomEdit(r, ds, chaos) {
  if (!chaos) return ds.commit(realisticEdit(r, ds.project));
  const next = structuredClone(ds.project);
  mutateOnce(r, next);
  ds.commit(next);
}

function twoPages(seed, projectOpts) {
  const r = rng(seed);
  const p0 = randProject(r, projectOpts);
  const svc = new MemDocService({ project: structuredClone(p0), rev: 7 });
  const A = page(svc, "A", structuredClone(p0));
  const B = page(svc, "B", structuredClone(p0));
  svc.drain();
  return { r, svc, A, B };
}

function assertSame(svc, ...pages) {
  const s = json(svc.project);
  for (const p of pages) {
    assert.equal(json(p.ds.project), s, `${p.ds.session} 与文档服务不一致`);
    assert.equal(p.ds.rev, svc.rev, `${p.ds.session} 的版本号 ${p.ds.rev} ≠ ${svc.rev}`);
    assert.equal(p.ds.unconfirmed, 0);
  }
}

/* ---------------- V2 ---------------- */

for (const [seed, chaos] of [[1, false], [2, false], [3, false], [4, false], [5, false], [6, true], [7, true], [8, true]]) {
  test(`V2-两个页面各 200 次随机${chaos ? "乱改" : "编辑"}交错提交,三份逐字节相同(种子 ${seed})`, () => {
    const { r, svc, A, B } = twoPages(seed);
    const left = { A: 200, B: 200 };
    let undos = 0;
    while (left.A || left.B) {
      const roll = r.int(10);
      if (roll < 4) {
        svc.step(r);
      } else {
        const who = left.A && (!left.B || r.chance(0.5)) ? "A" : "B";
        const p = who === "A" ? A : B;
        left[who]--;
        // 偶尔撤销 / 重做,撤销也是一次普通写入
        if (roll === 9 && p.ds.canUndo()) { p.ds.undo(); undos++; }
        else if (roll === 8 && p.ds.canRedo()) p.ds.redo();
        else randomEdit(r, p.ds, chaos);
      }
    }
    svc.drain(r);
    assertSame(svc, A, B);
    // 账对得上:每条发出去的提交要么落地、要么被拒并通知了页面,没有悄悄丢的;落地的没有重复
    for (const p of [A, B]) {
      const sentIds = new Set(p.sent.filter((m) => m.type === "project.op").map((m) => m.opId));
      const landed = svc.log.filter((e) => e.session === p.ds.session).map((e) => e.opId);
      const rejectedIds = p.notices.filter((n) => n.kind === "rejected").map((n) => n.opId);
      assert.equal(new Set(landed).size, landed.length);
      assert.equal(sentIds.size, landed.length + rejectedIds.length, `${p.ds.session}:发出 ${sentIds.size},落地 ${landed.length},被拒 ${rejectedIds.length}`);
    }
    const bySession = { A: 0, B: 0 };
    for (const e of svc.log) bySession[e.session]++;
    const rejected = [...A.notices, ...B.notices].filter((n) => n.kind === "rejected" || n.kind === "replay-dropped").length;
    console.log(`V2 种子 ${seed}${chaos ? "(乱改)" : ""}:落地 A ${bySession.A}、B ${bySession.B},被拒或重放丢弃 ${rejected},撤销 ${undos},最终 rev ${svc.rev}`);
    assert.ok(bySession.A >= 60 && bySession.B >= 60, JSON.stringify(bySession));
    assert.ok(undos > 0);
  });
}

test("V2-收到别人的操作不进自己的撤销栈、不回发", () => {
  const { svc, A, B } = twoPages(11);
  const next = structuredClone(A.ds.project);
  next.name = "A 改的";
  A.ds.commit(next);
  svc.drain();
  assert.equal(B.ds.project.name, "A 改的");
  assert.equal(B.ds.canUndo(), false);
  assert.equal(B.sent.filter((m) => m.type === "project.op").length, 0);
  assertSame(svc, A, B);
});

test("V2-有未确认操作时收到远端操作:撤回、应用远端、重放,本地先看到自己的改动", () => {
  const { svc, A, B } = twoPages(12);
  const a = structuredClone(A.ds.project);
  a.width = 111;
  A.ds.commit(a);
  const b = structuredClone(B.ds.project);
  b.height = 222;
  B.ds.commit(b);
  // B 的先落地;A 的还在路上时先收到 B 的
  svc.handle(B.conn, B.conn.up.shift());
  svc.handle(A.conn, A.conn.up.shift());
  A.conn.onMessage(A.conn.down.shift()); // project.ops(B 的)
  assert.equal(A.ds.project.width, 111);
  assert.equal(A.ds.project.height, 222);
  svc.drain();
  assertSame(svc, A, B);
});

/* ---------------- V5 ---------------- */

function clipsProject() {
  return {
    version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: 30, duration: 30, themeId: "midnight", media: [],
    tracks: [{ id: "t1", name: "序列 1", clips: [
      { id: "c1", cardId: "title", start: 0, end: 2, params: { text: "一" } },
      { id: "c2", cardId: "title", start: 3, end: 5, params: { text: "二" } },
    ] }],
  };
}

function setupClips(extra) {
  const svc = new MemDocService({ project: clipsProject(), rev: 1, ...extra });
  const A = page(svc, "A", clipsProject());
  const B = page(svc, "B", clipsProject());
  svc.drain();
  return { svc, A, B };
}

const withText = (p, id, text) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, params: { ...c.params, text } } : c)) })) });
const textOf = (p, id) => p.tracks[0].clips.find((c) => c.id === id)?.params.text;

test("V5-A 改片段 1、2,B 随后改片段 2;A 撤销:片段 1 回去,片段 2 保持 B 的,A 知道片段 2 因 B 改过没撤", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(withText(A.ds.project, "c1", "A1"), "c2", "A2"));
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, true);
  assert.deepEqual(res.skipped.map((s) => [s.entity, s.by.session]), [["/tracks/@t1/clips/@c2", "B"]]);
  assert.equal(textOf(A.ds.project, "c1"), "一");
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  svc.drain();
  assertSame(svc, A, B);
  // 撤销是一次新的写入,带 undoOf,别人照常收到
  const last = svc.log[svc.log.length - 1];
  assert.equal(last.session, "A");
  assert.equal(last.undoOf, svc.log[svc.log.length - 3].opId);
  assert.equal(textOf(B.ds.project, "c1"), "一");
  // 重做:把撤掉的那一处(片段 1)再做回来
  assert.equal(A.ds.canRedo(), true);
  const redo = A.ds.redo();
  assert.equal(redo.done, true);
  svc.drain();
  assert.equal(textOf(B.ds.project, "c1"), "A1");
  assert.equal(textOf(B.ds.project, "c2"), "B2");
  assertSame(svc, A, B);
  assert.ok(A.notices.some((n) => n.kind === "undo" && n.result.skipped.length === 1));
});

test("V5-全部没撤成:出栈,也不进重做栈", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c2", "A2"));
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, false);
  assert.equal(res.skipped.length, 1);
  assert.equal(A.ds.canUndo(), false);
  assert.equal(A.ds.canRedo(), false);
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-自己后来改过的不算冲突;别人改过又被我撤了中间一步,也照样挡住", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c2", "A2")); // 第 1 步
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  svc.drain();
  A.ds.commit(withText(A.ds.project, "c2", "A3")); // 第 2 步,盖掉 B 的
  svc.drain();
  // 撤第 2 步:它之后没人改过 → 撤成,回到 B2
  assert.equal(A.ds.undo().done, true);
  svc.drain();
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  // 撤第 1 步:它之后 B 改过 → 不撤
  const res = A.ds.undo();
  assert.equal(res.done, false);
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-父级被别人删了:落不下去的那处记为没撤成,其余照撤", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const base = { ...clipsProject(), tracks: [...clipsProject().tracks, { id: "t2", name: "序列 2", clips: [{ id: "c9", cardId: "x", start: 0, end: 1, params: {} }] }] };
  svc.project = structuredClone(base);
  const A = page(svc, "A", structuredClone(base));
  const B = page(svc, "B", structuredClone(base));
  svc.drain();
  const a = structuredClone(A.ds.project);
  a.tracks[1].clips[0].start = 0.5;
  a.name = "A 的名字";
  A.ds.commit(a);
  svc.drain();
  const b = structuredClone(B.ds.project);
  b.tracks.splice(1, 1); // B 删了序列 2(实体 /tracks/@t2,与片段 c9 不是同一个实体)
  B.ds.commit(b);
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, true);
  assert.deepEqual(res.failed, ["/tracks/@t2/clips/@c9"]);
  assert.equal(A.ds.project.name, "p");
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-还没确认的一步也能撤;撤销后有新操作,重做栈清空", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "x"));
  A.ds.undo();
  assert.equal(textOf(A.ds.project, "c1"), "一");
  assert.equal(A.ds.canRedo(), true);
  A.ds.commit(withText(A.ds.project, "c2", "y"));
  assert.equal(A.ds.canRedo(), false);
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-数字框 300 ms 内的连续输入合并成一步;超过 300 ms 另起一步;栈上限 100", () => {
  let t = 1000;
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = page(svc, "A", clipsProject(), { now: () => t });
  svc.drain();
  for (let i = 0; i < 5; i++) {
    A.ds.commit({ ...A.ds.project, width: 1000 + i }, { mergeKey: "width" });
    t += 100;
  }
  t += 400;
  A.ds.commit({ ...A.ds.project, width: 7 }, { mergeKey: "width" });
  svc.drain();
  assert.equal(svc.log.filter((e) => e.session === "A").length, 6); // 每次输入照样各提交一次
  A.ds.undo();
  assert.equal(A.ds.project.width, 1004);
  A.ds.undo();
  assert.equal(A.ds.project.width, 1920);
  assert.equal(A.ds.canUndo(), false);
  svc.drain();
  assertSame(svc, A);
  // 上限
  for (let i = 0; i < 130; i++) { t += 1000; A.ds.commit({ ...A.ds.project, fps: i + 1 }); }
  let n = 0;
  while (A.ds.canUndo()) { A.ds.undo(); n++; }
  assert.equal(n, 100);
  assert.equal(A.ds.project.fps, 30);
  svc.drain();
  assertSame(svc, A);
});

test("V5-别人撤销:画面直接变,不进我的栈", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.drain();
  A.ds.undo();
  svc.drain();
  assert.equal(textOf(B.ds.project, "c1"), "一");
  assert.equal(B.ds.canUndo(), false);
  assertSame(svc, A, B);
});

/* ---------------- 覆盖通知 ---------------- */

test("覆盖通知-被覆盖方先把自己那一版存成本地备份,覆盖方收到 overwrote", () => {
  const { svc, A, B } = setupClips({ overwriteWindowMs: 600_000 });
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c1", "B1"));
  svc.drain();
  assert.ok(B.notices.some((n) => n.kind === "overwrote" && n.entities[0].entity === "/tracks/@t1/clips/@c1"));
  assert.equal(A.backups.length, 1);
  assert.equal(A.backups[0].kind, "overwritten");
  assert.equal(A.backups[0].entity, "/tracks/@t1/clips/@c1");
  assert.equal(A.backups[0].value.params.text, "A1"); // 是 A 自己原来那一版
  assert.equal(textOf(A.ds.project, "c1"), "B1");
  assertSame(svc, A, B);
});

/* ---------------- V6 ---------------- */

test("V6-断线期间改 20 次,恢复后按顺序落地,只有第一条带 expectRev", () => {
  const { svc, A, B } = setupClips();
  const rev0 = svc.rev;
  A.down();
  assert.equal(A.ds.status, "offline");
  for (let i = 0; i < 20; i++) A.ds.commit(withText(A.ds.project, "c1", `离线 ${i}`));
  assert.equal(svc.rev, rev0);
  A.sent.length = 0;
  A.up();
  svc.drain();
  const ops = A.sent.filter((m) => m.type === "project.op");
  assert.equal(ops.length, 20);
  assert.equal(ops[0].expectRev, rev0);
  assert.ok(ops.slice(1).every((m) => m.expectRev === undefined));
  assert.equal(svc.rev, rev0 + 20);
  assert.deepEqual(svc.log.slice(-20).map((e) => e.opId), ops.map((m) => m.opId));
  assert.equal(textOf(svc.project, "c1"), "离线 19");
  assert.equal(A.ds.status, "online");
  assertSame(svc, A, B);
});

function offlineConflict() {
  const ctx = setupClips();
  const { svc, A, B } = ctx;
  A.down();
  for (let i = 0; i < 20; i++) A.ds.commit(withText(A.ds.project, "c1", `离线 ${i}`));
  B.ds.commit(withText(B.ds.project, "c2", "B 在 A 离线时改的"));
  svc.drain();
  A.sent.length = 0;
  A.up();
  svc.drain();
  return ctx;
}

test("V6-离线期间别人也改过:第一条被拒,整批停下", () => {
  const { svc, A } = offlineConflict();
  assert.equal(A.ds.status, "paused");
  const info = A.ds.pausedInfo;
  assert.equal(info.queued, 20);
  assert.equal(info.since.length, 1);
  assert.equal(info.since[0].session, "B");
  assert.equal(A.sent.filter((m) => m.type === "project.op").length, 1); // 其余 19 条没发
  assert.equal(svc.log.filter((e) => e.session === "A").length, 0);
  assert.equal(textOf(A.ds.project, "c1"), "离线 19"); // 本地仍是离线时的样子
});

test("V6-选「重放」:去掉期望版本依次提交,三份一致,别人的改动也在", async () => {
  const { svc, A, B } = offlineConflict();
  A.ds.replayOffline();
  svc.drain();
  assert.equal(A.ds.status, "online");
  const sessions = svc.log.slice(-21).map((e) => e.session);
  assert.deepEqual(sessions, ["B", ...Array(20).fill("A")]);
  assert.ok(svc.log.slice(-20).every((e) => e.expectRev === undefined));
  assert.equal(textOf(svc.project, "c1"), "离线 19");
  assert.equal(textOf(svc.project, "c2"), "B 在 A 离线时改的");
  assertSame(svc, A, B);
  const settled = await A.ds.whenSettled({ timeoutMs: 100 });
  assert.equal(settled.rev, svc.rev);
});

test("V6-选「丢弃」:先把这批存成本地备份,本地回到服务端版本", () => {
  const { svc, A, B } = offlineConflict();
  const revBefore = svc.rev;
  A.ds.discardOffline();
  assert.equal(A.ds.status, "online");
  assert.equal(A.backups.length, 1);
  const b = A.backups[0];
  assert.equal(b.kind, "offline-discard");
  assert.equal(b.batch.length, 20);
  assert.equal(textOf(b.project, "c1"), "离线 19");
  assert.equal(A.ds.canUndo(), false);
  svc.drain();
  assert.equal(svc.rev, revBefore);
  assert.equal(textOf(A.ds.project, "c1"), "一");
  assertSame(svc, A, B);
});

test("V6-在途提交其实已落地、断线丢了 ok:重连后原 opId 重发,文档服务去重,不误判冲突", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "在途"));
  svc.handle(A.conn, A.conn.up.shift()); // 文档服务收到并落地
  A.down(); // ok 还没投就断了
  A.ds.commit(withText(A.ds.project, "c2", "离线"));
  A.up();
  svc.drain();
  assert.equal(A.ds.status, "online");
  assert.equal(svc.log.filter((e) => e.session === "A").length, 2);
  assertSame(svc, A, B);
});

test("V6-断线时在途提交没到文档服务:重连后照常补发", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "在途"));
  A.down(); // 上行丢了
  A.up();
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "在途");
  assertSame(svc, A, B);
});

/* ---------------- V7 ---------------- */

test("V7-有未确认操作时点保存:等到确认后才写,写出的内容与文档服务的 rev 一致", async () => {
  const { svc, A, B } = setupClips();
  for (let i = 0; i < 5; i++) A.ds.commit(withText(A.ds.project, "c1", `存 ${i}`));
  let written = null;
  const save = A.ds.whenSettled({ timeoutMs: 1000 }).then((s) => { written = { rev: s.rev, text: json(s.project) }; });
  await Promise.resolve();
  assert.equal(written, null); // 还没确认,不写
  svc.drain();
  await save;
  assert.equal(written.rev, svc.rev);
  assert.equal(written.text, json(svc.project));
  assertSame(svc, A, B);
});

test("V7-离线时保存:一直等,超时就报错", async () => {
  const { A } = setupClips();
  A.down();
  A.ds.commit(withText(A.ds.project, "c1", "x"));
  await assert.rejects(A.ds.whenSettled({ timeoutMs: 30 }), /超时/);
});

test("V7-没有未确认操作:立刻返回当前版本", async () => {
  const { svc, A } = setupClips();
  const s = await A.ds.whenSettled();
  assert.equal(s.rev, svc.rev);
});

/* ---------------- 其它协议细节 ---------------- */

test("文档服务还没有这个项目:用根替换把本地这份写进去", () => {
  const svc = new MemDocService();
  const A = page(svc, "A", clipsProject());
  A.ds.commit(withText(A.ds.project, "c1", "先改了"));
  svc.drain();
  assert.equal(svc.rev, 1);
  assert.deepEqual(svc.log[0].ops[0].path, "");
  assert.equal(textOf(svc.project, "c1"), "先改了");
  const B = page(svc, "B", clipsProject());
  svc.drain();
  assertSame(svc, A, B);
});

test("被拒(bad-path)的提交撤回本地、拿掉对应的撤销步", () => {
  const { svc, A, B } = setupClips();
  // B 删掉片段 1;A 还不知道,改了片段 1 的文字 —— A 的操作到文档服务时路径已不存在
  const b = structuredClone(B.ds.project);
  b.tracks[0].clips.splice(0, 1);
  B.ds.commit(b);
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.handle(B.conn, B.conn.up.shift());
  svc.handle(A.conn, A.conn.up.shift());
  svc.drain();
  assert.ok(A.notices.some((n) => n.kind === "rejected" && n.reason === "bad-path"));
  assert.equal(A.ds.canUndo(), false);
  assertSame(svc, A, B);
});

/* ---------------- V8 ---------------- */

// 计时分批:每批 40 次提交,最多 8 批、批间隔 100 ms,任一批提交一侧的中位数 ≤ 5 ms 即停。机器忙(几份 npm test 并行)时
// 某一批可能整体被拖慢;判据(某批中位数 ≤ 5 ms)不变,第一批就是原来那一批,代码真退化时每一批都超,照样拦得住。
// 做法同 src/kernel/diffProject.test.mjs 的 timeIt。每次提交后都 drain,最后 A、B 与服务端一致照旧核对。
test("V8-1000 个片段的项目:页面提交一侧(差异 + 本地落地)≤ 5 ms,到另一页面看到变化", async () => {
  const r = rng(8);
  const big = bigProject(r, 1000);
  const svc = new MemDocService({ project: structuredClone(big), rev: 1 });
  const A = page(svc, "A", structuredClone(big));
  const B = page(svc, "B", structuredClone(big));
  svc.drain();
  const batches = [];
  for (let b = 0; b < 8 && !(batches.length && Math.min(...batches.map((x) => x.med)) <= 5); b++) {
    if (b > 0) await new Promise((res) => setTimeout(res, 100));
    const times = [];
    const e2e = [];
    for (let i = 0; i < 40; i++) {
      const p = A.ds.project;
      const ti = i % 10;
      const next = { ...p, tracks: p.tracks.map((t, k) => (k === ti ? { ...t, clips: t.clips.map((c, j) => (j === 42 ? { ...c, start: c.start + 0.01, end: c.end + 0.01 } : c)) } : t)) };
      const t0 = performance.now();
      A.ds.commit(next);
      const t1 = performance.now();
      svc.drain();
      const t2 = performance.now();
      times.push(t1 - t0);
      e2e.push(t2 - t0);
    }
    times.sort((a, c) => a - c);
    e2e.sort((a, c) => a - c);
    batches.push({ med: times[times.length >> 1], e2e: e2e[e2e.length >> 1] });
  }
  const best = batches.reduce((a, c) => (c.med < a.med ? c : a));
  console.log(`V8 docsync 提交(1000 片段):median ${best.med.toFixed(3)} ms;经内存假件到 B:median ${best.e2e.toFixed(3)} ms(量了 ${batches.length} 批)`);
  assert.ok(best.med <= 5, `提交一侧:量了 ${batches.length} 批,最好的一批中位数 ${best.med} ms`);
  assertSame(svc, A, B);
});

test("V5-项目设置的顶层字段各算一个实体(集成裁定):别人改了 fps,我照样撤得回 name;别人改了 name 才挡", () => {
  const { svc, A, B } = setupClips();
  const name0 = A.ds.project.name;
  A.ds.commit({ ...A.ds.project, name: "A 的名字" });
  svc.drain();
  B.ds.commit({ ...B.ds.project, fps: 60 });
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, true);
  assert.deepEqual(res.skipped, []);
  svc.drain();
  assert.equal(A.ds.project.name, name0);
  assert.equal(A.ds.project.fps, 60, "B 的 fps 保留");
  assertSame(svc, A, B);

  A.ds.commit({ ...A.ds.project, name: "A 又改名" });
  svc.drain();
  B.ds.commit({ ...B.ds.project, name: "B 改名" });
  svc.drain();
  const res2 = A.ds.undo();
  assert.equal(res2.done, false);
  assert.deepEqual(res2.skipped.map((s) => [s.entity, s.by.session]), [["/meta/name", "B"]]);
  assertSame(svc, A, B);
});

/* ---------------- 与文档服务实现对齐的协议细节 ---------------- */

test("协议-大项目分片的 project.state:拼完之前到的 project.ops 先攒着,拼完按序应用", () => {
  const p0 = clipsProject();
  const sent = [];
  const ds = new DocSync(p0, { projectId: "P", session: "A", send: (m) => sent.push(m) });
  ds.connect();
  const text = JSON.stringify(p0);
  const chunks = [text.slice(0, 50), text.slice(50, 120), text.slice(120)];
  ds.receive({ type: "project.state", rev: 10, parts: 3 });
  ds.receive({ type: "project.state.part", rev: 10, index: 0, count: 3, data: chunks[0] });
  ds.receive({ type: "project.ops", rev: 10, opId: "old", ops: [{ op: "set", path: "/name", value: "旧的,快照里已有" }], actor: { session: "B" } });
  ds.receive({ type: "project.ops", rev: 11, opId: "x", ops: [{ op: "set", path: "/name", value: "B 改的" }], actor: { session: "B" } });
  ds.receive({ type: "project.state.part", rev: 10, index: 2, count: 3, data: chunks[2] });
  ds.receive({ type: "project.state.part", rev: 10, index: 1, count: 3, data: chunks[1] });
  assert.equal(ds.status, "connecting");
  ds.receive({ type: "project.state.end", rev: 10 });
  assert.equal(ds.status, "online");
  assert.equal(ds.rev, 11);
  assert.equal(ds.project.name, "B 改的");
});

test("协议-project.ops 带 resync(大根替换不带操作):重新 project.open", () => {
  const { svc, A } = setupClips();
  const opens = A.sent.filter((m) => m.type === "project.open").length;
  A.ds.receive({ type: "project.ops", rev: svc.rev + 1, opId: "big", resync: true, actor: { session: "B" } });
  assert.equal(A.sent.filter((m) => m.type === "project.open").length, opens + 1);
  assert.ok(A.notices.some((n) => n.kind === "resync"));
});

test("协议-两人同时删同一片段:后到的照常落地(空操作),三份一致", () => {
  const { svc, A, B } = setupClips();
  const del = (p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== "c1") })) });
  A.ds.commit({ ...del(A.ds.project), name: "A 同批的其它修改" });
  B.ds.commit(del(B.ds.project));
  svc.handle(B.conn, B.conn.up.shift());
  svc.handle(A.conn, A.conn.up.shift());
  svc.drain();
  assert.equal(A.notices.filter((n) => n.kind === "rejected").length, 0);
  assert.equal(svc.project.name, "A 同批的其它修改");
  assertSame(svc, A, B);
});

/* ---------------- 计划内换连接(handover;账号云端项目的连接到期前换到新会话上) ---------------- */

/** 能换连接的页面:`swap()` = 新连接已经建好,旧连接作废(旧连接上没处理的上行按 `dropUp` 丢或不丢、没投的下行一律丢) */
function swappable(svc, session, initial) {
  const notices = [];
  const projects = [];
  let link = null;
  const sent = [];
  const ds = new DocSync(initial, { projectId: "P", session, send: (msg) => { sent.push(msg); link?.send(msg); }, saveBackup: () => {} });
  ds.on("notice", (n) => notices.push(n));
  ds.on("project", (p, cause) => projects.push(cause));
  link = svc.connect(session, (msg) => ds.receive(msg));
  ds.connect();
  const swap = (opts) => {
    const old = link;
    link = svc.connect(session, (msg) => ds.receive(msg));
    svc.disconnect(old.conn, opts);
    ds.handover();
  };
  /** 换连接但旧连接留在服务端(调用方自己管它的上行、下行):模拟旧连接上在途的提交换完之后才落地 */
  swap.keepOld = () => {
    link = svc.connect(session, (msg) => ds.receive(msg));
    ds.handover();
  };
  return { ds, notices, projects, sent, swap };
}

test("HO-01 换连接时没确认的提交(发了没回音的、换的那一下新做的)换完都补发并确认;别人在这期间的改动也收到;不走离线批次", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = swappable(svc, "A", clipsProject());
  const B = page(svc, "B", clipsProject());
  svc.drain();
  const rev0 = svc.rev;
  // A 发了一条,服务端还没处理(换连接时丢在旧连接上);B 同时改了另一个片段并已落地
  A.ds.commit(withText(A.ds.project, "c1", "A 换之前"));
  B.ds.commit(withText(B.ds.project, "c2", "B 期间"));
  while (svc.conns.size && [...svc.conns].find((c) => c.session === "B").up.length) svc.handle([...svc.conns].find((c) => c.session === "B"), [...svc.conns].find((c) => c.session === "B").up.shift());
  A.sent.length = 0;
  A.swap({ dropUp: true });
  // 换的那一下(新连接还在等状态)又做了一条
  A.ds.commit(withText(A.ds.project, "c1", "A 换的时候"));
  assert.notEqual(A.ds.status, "offline", "计划内换连接不显示离线");
  svc.drain();
  assert.equal(A.ds.status, "online");
  assert.equal(A.ds.unconfirmed, 0);
  assert.equal(svc.rev, rev0 + 3);
  assert.equal(textOf(svc.project, "c1"), "A 换的时候");
  assert.equal(textOf(svc.project, "c2"), "B 期间");
  assert.equal(textOf(A.ds.project, "c2"), "B 期间", "别人的改动收到了");
  const ops = A.sent.filter((m) => m.type === "project.op");
  assert.equal(ops.length, 2);
  assert.ok(ops.every((m) => m.expectRev === undefined), "不带期望版本:别人恰好这时改了也不会被判成离线冲突");
  assert.equal(A.notices.filter((n) => n.kind === "rejected" || n.kind === "resync" || n.kind === "replay-dropped").length, 0);
  assertSame(svc, A, B);
});

test("HO-02 旧连接上已经落地、只是确认没收到的提交:换完按 opId 去重,不落第二次", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = swappable(svc, "A", clipsProject());
  svc.drain();
  const rev0 = svc.rev;
  A.ds.commit(withText(A.ds.project, "c1", "已落地"));
  // 旧连接上行照常处理(dropUp: false),确认丢在旧连接的下行里
  A.swap({ dropUp: false });
  assert.equal(svc.rev, rev0 + 1);
  svc.drain();
  assert.equal(svc.rev, rev0 + 1, "没有落第二次");
  assert.equal(A.ds.unconfirmed, 0);
  assert.equal(textOf(A.ds.project, "c1"), "已落地");
  assert.equal(A.notices.length, 0);
});

test("HO-03 换的这一下没有新版本:手里的项目对象原样留着(不换新对象,界面不重算)", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = swappable(svc, "A", clipsProject());
  svc.drain();
  const before = A.ds.project;
  A.projects.length = 0;
  A.swap({ dropUp: true });
  svc.drain();
  assert.equal(A.ds.project, before);
  assert.deepEqual(A.projects, []);
  assert.equal(A.ds.status, "online");
  // 之后照常提交
  A.ds.commit(withText(A.ds.project, "c1", "换完之后"));
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "换完之后");
});

test("HO-04 本来就在离线批次里:换连接不改离线的规矩(第一条仍带期望版本)", () => {
  const { svc, A } = setupClips();
  const rev0 = svc.rev;
  A.down();
  A.ds.commit(withText(A.ds.project, "c1", "离线改的"));
  A.sent.length = 0;
  A.up();
  A.ds.handover();
  svc.drain();
  const ops = A.sent.filter((m) => m.type === "project.op");
  assert.equal(ops.at(-1).expectRev, rev0);
  assert.equal(textOf(svc.project, "c1"), "离线改的");
  assert.equal(A.ds.status, "online");
});

test("HO-05 换连接时旧连接上有两条在途:前一条已含在新状态里、后一条换完才落地并先回来 —— 整份重取一次,最后与文档服务一致", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = swappable(svc, "A", clipsProject());
  svc.drain();
  const rev0 = svc.rev;
  const connA = () => [...svc.conns].filter((c) => c.session === "A");
  A.ds.commit(withText(A.ds.project, "c1", "X"));
  A.ds.commit(withText(A.ds.project, "c2", "Y"));
  const old = connA()[0];
  // X 在旧连接上先落地(确认留在旧连接的下行里,换完就丢)
  svc.handle(old, old.up.shift());
  const yMsg = old.up.shift();
  A.swap({ dropUp: true });
  const fresh = connA()[0];
  // 新连接先拿到状态(含 X);这时 Y 才经旧连接落地,回发给新连接;重发的 X、Y 的回音在后面
  svc.handle(fresh, fresh.up.shift());
  fresh.onMessage(fresh.down.shift());
  svc.handle({ ...old, open: true, down: [] }, yMsg);
  svc.drain();
  assert.equal(svc.rev, rev0 + 2);
  assert.equal(A.ds.unconfirmed, 0);
  assert.equal(textOf(A.ds.project, "c1"), "X");
  assert.equal(textOf(A.ds.project, "c2"), "Y");
  // 不去猜前一条落没落地:确认先后颠倒就整份重取(静默的,不给用户提示),只许这一种通知
  assert.deepEqual(A.notices.filter((n) => n.kind !== "remote").map((n) => n.kind), ["resync"]);
  assert.equal(JSON.stringify(A.ds.project), JSON.stringify(svc.project));
  assert.equal(JSON.stringify(A.ds.confirmedProject), JSON.stringify(svc.project));
});

test("HO-06 审查复现:前一条在旧连接上没落地(闸拒了、页面不知道)、后一条换完才经旧连接落地 —— 页面不能停在与文档服务不一致的内容上", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = swappable(svc, "A", clipsProject());
  svc.drain();
  const connA = () => [...svc.conns].filter((c) => c.session === "A");
  A.ds.commit({ ...A.ds.project, name: "X" });
  A.ds.commit({ ...A.ds.project, name: "Y" });
  const old = connA()[0];
  old.up.shift();                 // X:旧连接上没落(闸回了不带提交号的错误)
  const yMsg = old.up.shift();    // Y:还在路上
  A.swap({ dropUp: true });
  const fresh = connA()[0];
  svc.handle(fresh, fresh.up.shift());                  // 新连接拿到状态(不含 X、Y)
  fresh.onMessage(fresh.down.shift());
  svc.handle({ ...old, open: true, down: [] }, yMsg);   // Y 经旧连接落地,回发给新连接
  svc.drain();
  // 文档服务上是先 Y 后 X;页面必须也是
  assert.equal(svc.project.name, "X");
  assert.equal(A.ds.project.name, "X");
  assert.equal(A.ds.confirmedProject.name, "X");
  assert.equal(A.ds.unconfirmed, 0);
  assert.equal(A.ds.rev, svc.rev);
});

/**
 * 穷举:换连接的那一刻旧连接上有 2～3 条在途的提交(都改同一个字段,另各带一个自己的字段),每条枚举三种去向 ——
 *   gate   旧连接上被闸拒了(回的是不带提交号的错误,页面不知道),没落地;
 *   before 在新连接拿到状态之前就经旧连接落地了(回音丢在旧连接上);
 *   after  换完之后才经旧连接落地(回音会从新连接回来,和重发的那一条、别的回音先后不定)。
 * 再叠上:换的那一下又做了一条没有、别的成员同时改没改;每种组合用若干个随机种子打乱投递顺序。
 * 安静下来之后只许两种结局:页面本地副本、已确认副本与文档服务内容相同且没有未确认的(中途整份重取过不算错);不许「不一致且没有任何动静」。
 */
test("HO-07 穷举换连接时在途提交的各种去向与回音先后:安静下来时页面与文档服务一致、未确认为 0", () => {
  const FATES = ["gate", "before", "after"];
  const combos = (n) => (n === 0 ? [[]] : combos(n - 1).flatMap((c) => FATES.map((f) => [...c, f])));
  const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
  let cases = 0, resynced = 0;
  for (const n of [2, 3]) for (const fates of combos(n)) for (const late of [false, true]) for (const other of [false, true]) for (let seed = 1; seed <= 8; seed++) {
    const label = `${fates.join(",")} late=${late} other=${other} seed=${seed}`;
    const svc = new MemDocService({ project: clipsProject(), rev: 1 });
    const A = swappable(svc, "A", clipsProject());
    const B = page(svc, "B", clipsProject());
    svc.drain();
    for (let i = 0; i < n; i++) A.ds.commit({ ...A.ds.project, name: `v${i}`, [`k${i}`]: i });
    const old = [...svc.conns].find((c) => c.session === "A");
    const msgs = old.up.splice(0);
    assert.equal(msgs.length, n, label);
    // before:现在就落地(回音留在旧连接上,不投给页面)
    msgs.forEach((m, i) => { if (fates[i] === "before") svc.handle(old, m); });
    old.down.length = 0;
    // 换连接:旧连接留在服务端(不再往页面投),after 的那几条还在它的上行队列里,由随机投递决定什么时候落地
    const quiet = old.onMessage;
    old.onMessage = () => {};
    msgs.forEach((m, i) => { if (fates[i] === "after") old.up.push(m); });
    A.swap.keepOld();
    if (late) A.ds.commit({ ...A.ds.project, name: "late", late: 1 });
    if (other) B.ds.commit({ ...B.ds.project, other: seed });
    svc.drain(rng(seed));
    svc.drain();
    void quiet;
    cases++;
    if (A.notices.some((x) => x.kind === "resync")) resynced++;
    assert.equal(A.ds.unconfirmed, 0, `${label}:还有没确认的`);
    assert.equal(canon(A.ds.project), canon(svc.project), `${label}:页面本地副本与文档服务不一致`);
    assert.equal(canon(A.ds.confirmedProject), canon(svc.project), `${label}:页面已确认副本与文档服务不一致`);
    assert.equal(A.ds.rev, svc.rev, `${label}:版本号`);
    assert.equal(canon(B.ds.project), canon(svc.project), `${label}:别的成员与文档服务不一致`);
    assert.deepEqual(A.notices.filter((x) => !["remote", "resync"].includes(x.kind)).map((x) => x.kind), [], `${label}:不该有被拒、丢弃之类的通知`);
    assert.equal(A.ds.status, "online", label);
  }
  assert.equal(cases, (9 + 27) * 2 * 2 * 8);
  assert.ok(resynced > 0 && resynced < cases, `其中 ${resynced} / ${cases} 种走了整份重取`);
});
