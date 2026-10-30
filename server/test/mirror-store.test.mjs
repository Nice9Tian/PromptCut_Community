import test from "node:test";
import assert from "node:assert/strict";
import { createMirrorStore, MAX_VERSIONS } from "../mirror-store.mjs";
import { changedClips, projectHash } from "../../src/render/changedClips.mjs";

/**
 * 镜像的存储本体(A7)。两个进程(编辑器 / 预渲染)各挂一份,帧请求按 `{session, localRev}`
 * 来这儿取项目 —— 所以这份测试要钉死的是「什么时候取得到、什么时候必须让页面重推」:
 *
 * - **8 版窗口**:请求和推送会交错,一个在飞的取帧请求要的是两秒前那一版;
 * - **stale**:两次推送乱序到达时旧的不能盖掉新的(不是错,回 200);
 * - **resync(409)**:补丁的基线滑出窗口、或者应用完哈希对不上 —— 哈希这一道是**唯一**
 *   能发现「两层 diff 自己写错了」的地方,漏掉它镜像会带着一份悄悄错掉的项目一直服务下去;
 * - **回拉补一版**(`insert`)不走 stale 闸:它按定义补的就是旧版本;
 * - **播放头**和项目分开存。
 */

const clip = (id, over = {}) => ({ id, start: 0, end: 1, kind: "card", cardId: "c", ...over });
const track = (id, n) => ({ id, name: id, hidden: false, clips: Array.from({ length: n }, (_, i) => clip(`${id}-${i}`)) });
const BASE = {
  id: "p", name: "demo", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "dark", camera3dFov: 50,
  media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
};
const project = (tracks) => ({ ...BASE, tracks });

/** 拖一下第 `i` 段:store 是不可变更新,只有那一段和那条轨道换新对象 */
function drag(p, ti, ci, start) {
  const t = p.tracks[ti];
  return { ...p, tracks: p.tracks.map((x, i) => (i === ti ? { ...t, clips: t.clips.map((c, j) => (j === ci ? { ...c, start, end: start + 1 } : c)) } : x)) };
}

/** 页面那一侧:把 prev→next 的改动按两层 diff 推给 store */
function pushPatch(store, session, prev, next, fromLocalRev, toLocalRev) {
  return store.pushDiff({ session, fromLocalRev, toLocalRev, hash: projectHash(next), patch: changedClips(prev, next) });
}

test("整份推送:按 {session, localRev} 取得到", () => {
  const store = createMirrorStore();
  const p = project([track("t1", 2)]);
  const out = store.pushFull({ session: "s1", localRev: 1, project: p });
  assert.equal(out.status, "ok");
  assert.equal(out.localRev, 1);
  assert.equal(out.hash, projectHash(p));

  assert.equal(store.getMirror("s1", 1).project, p);
  assert.equal(store.getMirror("s1").localRev, 1, "不给号 = 最新一版");
  assert.equal(store.getMirror("s1", "1").project, p, "号从 query string 来的时候是字符串");
  assert.equal(store.getMirror("s1", 2), null);
  assert.equal(store.getMirror("别的会话"), null);
  assert.equal(store.latestMirror().project, p);
});

test("缺 session / 缺 project 就抛", () => {
  const store = createMirrorStore();
  assert.throws(() => store.pushFull({ session: "", localRev: 1, project: project([]) }), /缺少 session/);
  assert.throws(() => store.pushFull({ session: "s1", localRev: 1, project: null }), /缺少 project/);
  assert.throws(() => store.pushFull({ session: "s1", localRev: 1, project: { tracks: "nope" } }), /缺少 project/);
  assert.throws(() => store.pushDiff({ session: "", toLocalRev: 2 }), /缺少 session/);
});

test("8 版窗口:只留最近 8 版,更旧的取不到", () => {
  const store = createMirrorStore();
  assert.equal(MAX_VERSIONS, 8);
  let p = project([track("t1", 3)]);
  store.pushFull({ session: "s1", localRev: 1, project: p });
  for (let rev = 2; rev <= 12; rev++) {
    const next = drag(p, 0, 0, rev);
    assert.equal(pushPatch(store, "s1", p, next, rev - 1, rev).status, "ok", `第 ${rev} 版该收下`);
    p = next;
  }
  assert.deepEqual(store.revsOf("s1"), [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(store.getMirror("s1", 5));
  assert.equal(store.getMirror("s1", 4), null, "滑出窗口的取不到");
  assert.equal(store.latestMirror().localRev, 12);
});

test("stale:同 session 里号不大于已存最大号,回 stale 而不是错", () => {
  const store = createMirrorStore();
  const a = project([track("t1", 1)]);
  const b = drag(a, 0, 0, 5);
  store.pushFull({ session: "s1", localRev: 3, project: a });

  for (const rev of [3, 2, 0]) {
    const out = store.pushFull({ session: "s1", localRev: rev, project: b });
    assert.equal(out.status, "stale", `第 ${rev} 版该被当成乱序到达`);
    assert.equal(out.localRev, 3);
  }
  assert.equal(store.getMirror("s1", 3).project, a, "旧的没把新的盖掉");

  // 补丁那一路同一个判据
  const late = pushPatch(store, "s1", a, b, 2, 3);
  assert.equal(late.status, "stale");
});

test("两个编辑页标签互不覆盖", () => {
  const store = createMirrorStore();
  const a = project([track("a", 1)]);
  const b = project([track("b", 2)]);
  store.pushFull({ session: "tab-A", localRev: 7, project: a });
  store.pushFull({ session: "tab-B", localRev: 1, project: b });

  // B 的号比 A 小得多,但它是另一个 session —— 不该被当成 stale
  assert.equal(store.getMirror("tab-A", 7).project, a);
  assert.equal(store.getMirror("tab-B", 1).project, b);
  assert.equal(store.latestMirror().session, "tab-B", "Agent 取的是最后推的那个页面");
  assert.deepEqual(store.allLatest().map((v) => v.session).sort(), ["tab-A", "tab-B"]);
});

test("两层 diff:应用完和页面手里那份逐字相等", () => {
  const store = createMirrorStore();
  const a = project([track("t1", 3), track("t2", 2)]);
  store.pushFull({ session: "s1", localRev: 1, project: a });

  // 拖一段
  const b = drag(a, 0, 1, 4);
  assert.equal(pushPatch(store, "s1", a, b, 1, 2).status, "ok");
  assert.deepEqual(store.getMirror("s1", 2).project, b);
  // 没动过的对象在镜像里还是同一个引用(8 版共享结构,这是它不吃内存的原因)
  assert.equal(store.getMirror("s1", 2).project.tracks[1], a.tracks[1]);

  // 切轨道 hidden
  const c = { ...b, tracks: [{ ...b.tracks[0], hidden: true }, b.tracks[1]] };
  assert.equal(pushPatch(store, "s1", b, c, 2, 3).status, "ok");
  assert.equal(store.getMirror("s1", 3).project.tracks[0].hidden, true);

  // 删一段 + 换轨道顺序
  const d = { ...c, tracks: [c.tracks[1], { ...c.tracks[0], clips: c.tracks[0].clips.slice(1) }] };
  assert.equal(pushPatch(store, "s1", c, d, 3, 4).status, "ok");
  assert.deepEqual(store.getMirror("s1", 4).project.tracks.map((t) => t.id), ["t2", "t1"]);
  assert.equal(store.getMirror("s1", 4).hash, projectHash(d));

  // 改画幅:顶层字段变了 → changedClips 给整份,pushDiff 也认
  const e = { ...d, width: 1280 };
  assert.equal(pushPatch(store, "s1", d, e, 4, 5).status, "ok");
  assert.equal(store.getMirror("s1", 5).project.width, 1280);

  // 旧版本都还在,取帧请求晚到也拿得到
  assert.deepEqual(store.revsOf("s1"), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.getMirror("s1", 1).project, a);
});

test("resync(409):哈希对不上", () => {
  const store = createMirrorStore();
  const a = project([track("t1", 2)]);
  store.pushFull({ session: "s1", localRev: 1, project: a });
  const b = drag(a, 0, 0, 3);

  const out = store.pushDiff({ session: "s1", fromLocalRev: 1, toLocalRev: 2, hash: "0000000000000000", patch: changedClips(a, b) });
  assert.equal(out.status, "resync");
  assert.equal(out.reason, "hash");
  assert.equal(out.localRev, 1);
  assert.equal(out.hash, projectHash(b));
  assert.equal(store.getMirror("s1", 2), null, "对不上的那一版不能进来");

  // 页面收到 409 就整份重推,同一个号照样收
  assert.equal(store.pushFull({ session: "s1", localRev: 2, project: b }).status, "ok");
  assert.deepEqual(store.getMirror("s1", 2).project, b);
});

test("resync(409):基线滑出窗口 / 这个 session 一版都没有", () => {
  const store = createMirrorStore();
  const a = project([track("t1", 2)]);
  assert.equal(store.pushDiff({ session: "新页面", fromLocalRev: 0, toLocalRev: 1, patch: changedClips(a, a) }).reason, "session");

  let p = a;
  store.pushFull({ session: "s1", localRev: 1, project: p });
  for (let rev = 2; rev <= 12; rev++) { const n = drag(p, 0, 0, rev); pushPatch(store, "s1", p, n, rev - 1, rev); p = n; }

  // 窗口是 [5..12];拿第 3 版当基线的补丁补不回来
  const out = store.pushDiff({ session: "s1", fromLocalRev: 3, toLocalRev: 13, hash: "x", patch: { kind: "tracks", order: null, tracks: [] } });
  assert.equal(out.status, "resync");
  assert.equal(out.reason, "window");
  assert.equal(out.localRev, 12);
});

test("resync(409):补丁引用了不存在的轨道 / 片段", () => {
  const store = createMirrorStore();
  store.pushFull({ session: "s1", localRev: 1, project: project([track("t1", 1)]) });
  const out = store.pushDiff({ session: "s1", fromLocalRev: 1, toLocalRev: 2, patch: { kind: "tracks", order: null, tracks: [{ id: "幽灵轨道", props: {} }] } });
  assert.equal(out.status, "resync");
  assert.equal(out.reason, "apply");
  assert.match(out.error, /不存在的轨道/);
});

test("不给哈希也收(迁移期 / 脚本),但给了就一定校验", () => {
  const store = createMirrorStore();
  const a = project([track("t1", 1)]);
  const b = drag(a, 0, 0, 2);
  store.pushFull({ session: "s1", localRev: 1, project: a });
  assert.equal(store.pushDiff({ session: "s1", fromLocalRev: 1, toLocalRev: 2, patch: changedClips(a, b) }).status, "ok");
});

test("回拉补一版(insert):不走 stale 闸", () => {
  const store = createMirrorStore();
  let p = project([track("t1", 2)]);
  const v = [null, p];
  store.pushFull({ session: "s1", localRev: 1, project: p });
  for (let rev = 2; rev <= 4; rev++) { const n = drag(p, 0, 0, rev); pushPatch(store, "s1", p, n, rev - 1, rev); p = n; v[rev] = n; }
  // 第 5 版的转发丢了,第 6 版靠整份补上:手里现在缺 5
  const five = drag(p, 0, 0, 5);
  const six = drag(five, 0, 1, 6);
  store.pushFull({ session: "s1", localRev: 6, project: six });
  assert.equal(store.getMirror("s1", 5), null);

  // 一个在飞的取帧请求要第 5 版 —— 回拉回来只能走 insert,pushFull 会把它当乱序挡掉
  assert.equal(store.pushFull({ session: "s1", localRev: 5, project: five }).status, "stale");
  assert.equal(store.getMirror("s1", 5), null);
  const out = store.insert({ session: "s1", localRev: 5, project: five });
  assert.equal(out.status, "ok");
  assert.deepEqual(store.getMirror("s1", 5).project, five);
  assert.equal(store.latestMirror().localRev, 6, "补旧版不该动『最新一版』");
  assert.deepEqual(store.revsOf("s1"), [1, 2, 3, 4, 5, 6]);

  // 已经有的原样返回,不重复存
  assert.equal(store.insert({ session: "s1", localRev: 5, project: five }).status, "ok");
  assert.deepEqual(store.revsOf("s1"), [1, 2, 3, 4, 5, 6]);

  // 比窗口里最旧的还旧:存进去也会当场被挤掉,直说没接住
  let q = six;
  for (let rev = 7; rev <= 14; rev++) { const n = drag(q, 0, 0, rev); store.pushFull({ session: "s1", localRev: rev, project: n }); q = n; }
  assert.equal(store.revsOf("s1").length, 8);
  assert.equal(store.insert({ session: "s1", localRev: 2, project: v[2] }).status, "resync");
});

test("播放头:和项目分开存,跟着当前编辑页走", () => {
  const store = createMirrorStore();
  assert.equal(store.latestPlayhead(), null);

  const head = store.setPlayhead("s1", 3.5, false);
  assert.equal(head.t, 3.5);
  assert.equal(head.playing, false);
  assert.equal(store.latestPlayhead().t, 3.5, "还没推过项目也读得到(退回最近报过的那个)");

  store.pushFull({ session: "s1", localRev: 1, project: project([track("t1", 1)]) });
  assert.equal(store.latestPlayhead().t, 3.5);

  // 播放中报一次
  store.setPlayhead("s1", 9, true);
  assert.equal(store.latestPlayhead().playing, true);
  assert.equal(store.latestPlayhead().t, 9);

  // 另一个标签接管:latestMirror 跟着谁,播放头就跟着谁
  store.pushFull({ session: "s2", localRev: 1, project: project([track("t9", 1)]) });
  store.setPlayhead("s2", 1.25, false);
  assert.equal(store.latestMirror().session, "s2");
  assert.equal(store.latestPlayhead().t, 1.25);
  assert.equal(store.latestPlayhead().session, "s2");

  assert.throws(() => store.setPlayhead("", 1, false), /缺少 session/);
  assert.equal(store.setPlayhead("s1", "坏数", false).t, 0, "报了个非数就当 0,别把 NaN 传给渲染");
});

test("clear:把两张表都清干净", () => {
  const store = createMirrorStore();
  store.pushFull({ session: "s1", localRev: 1, project: project([track("t1", 1)]) });
  store.setPlayhead("s1", 2, false);
  store.clear();
  assert.equal(store.latestMirror(), null);
  assert.equal(store.latestPlayhead(), null);
  assert.deepEqual(store.allLatest(), []);
});

test("拖动 2 秒:每一次推送都远小于 8 KB", () => {
  const store = createMirrorStore();
  // 17 轨 × 10 段,和编辑台里一个中等项目差不多
  let p = project(Array.from({ length: 17 }, (_, i) => track(`t${i}`, 10)));
  const full = JSON.stringify({ session: "s1", localRev: 1, project: p }).length;
  store.pushFull({ session: "s1", localRev: 1, project: p });

  // 250 ms 防抖,2 秒 ≈ 8 次
  let worst = 0;
  for (let rev = 2; rev <= 9; rev++) {
    const next = drag(p, 9, 4, rev * 0.1);
    const body = JSON.stringify({ session: "s1", fromLocalRev: rev - 1, toLocalRev: rev, projectHash: projectHash(next), patch: changedClips(p, next) });
    worst = Math.max(worst, body.length);
    assert.equal(pushPatch(store, "s1", p, next, rev - 1, rev).status, "ok");
    p = next;
  }
  assert.ok(worst < 8 * 1024, `拖动时最大的一次推送 ${worst} 字节,超过 8 KB`);
  assert.ok(worst * 20 < full, `增量 ${worst} 字节对整份 ${full} 字节,省得不够多`);
});
