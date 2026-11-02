/**
 * 层表条目的输入签名(stale-layer,`layerInputSig.mjs`):渲染节点写层表时按它认下的那一版项目算,页面按当前项目算,
 * 对不上就是旧参数的层。用例:
 *   SIG-1 同一份项目两边算出同一个签名(JSON 往返后也一样);参数改了就变,改回原来的参数又回到原来的签名
 *   SIG-2 不进快照的东西(位置、缩放、旋转、不透明度、淡入淡出、motion、音量、整帧平移)改了签名不变
 *   SIG-3 进快照的东西(时长、亚帧相位、框宽高、parts、强调、画幅、fps、主题、style、滤镜库条目)改了签名变
 *   SIG-4 素材效果卡:上游节点、上游片段的参数改了,下游片段的签名变;环路不死循环
 *   SIG-5 比对:任何一边没有签名、算法版本不同都不判过期;片段不在项目里回 null
 *   SIG-6 服务端 `layerMapOf` 写进层表的 `inputSig` 与页面对同一份项目算的相同;项目里没有这个片段就不写这一项
 * 跑:node --test src/render/layerInputSig.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipInputSig, inputSigStale, cachedClipInputSig, LAYER_INPUT_SIG_VERSION } from "./layerInputSig.mjs";
import { layerMapOf } from "../../server/artifact-transfer.mjs";

function project(patch = {}) {
  return {
    version: 1, id: "proj-1", name: "p", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "midnight",
    style: { accent: "#f00" },
    media: [{ id: "m1", kind: "video", url: "blob:x", hash: "h".repeat(64) }],
    filters: [{ id: "f1", name: "blur", ops: [{ op: "blur", r: 2 }] }],
    tracks: [
      { id: "t1", name: "t1", clips: [
        { id: "a", cardId: "user-card", start: 1, end: 4, params: { title: "hello", n: 3 }, frame: { x: 10, y: 20, w: 800, h: 600, scale: 1 } },
        { id: "g", cardId: "graph-card", nodeId: "n2", start: 5, end: 8, params: { k: 1 } },
      ] },
      { id: "t2", name: "t2", clips: [
        { id: "v", mediaId: "m1", start: 0, end: 10, mediaOffset: 0, filter: { id: "f1", params: { r: 2 } } },
      ] },
    ],
    cardNodes: [
      { id: "n1", adapter: "card", cardId: "src-card", params: { level: 1 }, inputs: { source: { nodeId: "@clip/v/source" } } },
      { id: "n2", adapter: "card", cardId: "graph-card", params: { k: 1 }, inputs: { a: "n1" } },
    ],
    ...patch,
  };
}

/** 换掉某个片段(不原地改) */
function withClip(p, id, fn) {
  return { ...p, tracks: p.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === id ? fn(c) : c)) })) };
}

test("SIG-1 The same project gives the same signature; changing a parameter changes it, changing it back restores the original signature", () => {
  const p = project();
  const sig = clipInputSig(p, "a");
  assert.match(sig, new RegExp(`^i${LAYER_INPUT_SIG_VERSION}-[0-9a-f]{16}$`));
  assert.equal(clipInputSig(JSON.parse(JSON.stringify(p)), "a"), sig, "Same after a document service round trip");
  // 键的先后不同也一样(规范 JSON)
  const reordered = withClip(p, "a", (c) => ({ params: { n: 3, title: "hello" }, end: c.end, start: c.start, cardId: c.cardId, frame: c.frame, id: c.id }));
  assert.equal(clipInputSig(reordered, "a"), sig);
  const changed = withClip(p, "a", (c) => ({ ...c, params: { ...c.params, title: "world" } }));
  assert.notEqual(clipInputSig(changed, "a"), sig);
  assert.equal(clipInputSig(changed, "g"), clipInputSig(p, "g"), "Other clips are unaffected");
  const back = withClip(changed, "a", (c) => ({ ...c, params: { title: "hello", n: 3 } }));
  assert.equal(clipInputSig(back, "a"), sig, "Parameters changed back to the original");
});

test("SIG-2 Changing things that do not go into the snapshot leaves the signature unchanged", () => {
  const p = project();
  const sig = clipInputSig(p, "a");
  const same = [
    (c) => ({ ...c, frame: { ...c.frame, x: 500, y: -3, anchor: [0.5, 0.5], scale: 2, rotate: 30, rotateX: 5, rotateY: 5, translateZ: 9 } }),
    (c) => ({ ...c, opacity: 0.5, fadeIn: 0.3, fadeOut: 0.2 }),
    (c) => ({ ...c, motion: { mediaId: "m1", pointIndex: 0, offsets: [[0, 0]], visible: [true], frameStep: 1 / 30, whenHidden: "hold" } }),
    (c) => ({ ...c, audioVolume: 0.3, audioMuted: true, label: "Rename" }),
    (c) => ({ ...c, start: c.start + 2, end: c.end + 2 }), // 整帧平移(2 秒 = 60 帧)
  ];
  for (const [i, fn] of same.entries()) assert.equal(clipInputSig(withClip(p, "a", fn), "a"), sig, `Item ${i}`);
  // 别的轨道隐藏、改名也不动它
  assert.equal(clipInputSig({ ...p, name: "New name", tracks: p.tracks.map((tr) => ({ ...tr, name: "x", hidden: true })) }, "a"), sig);
});

test("SIG-3 Changing things that go into the snapshot changes the signature", () => {
  const p = project();
  const sig = clipInputSig(p, "a");
  const differ = [
    ["Duration", withClip(p, "a", (c) => ({ ...c, end: c.end + 1 }))],
    ["Subframe phase", withClip(p, "a", (c) => ({ ...c, start: c.start + 0.01, end: c.end + 0.01 }))],
    ["Frame width", withClip(p, "a", (c) => ({ ...c, frame: { ...c.frame, w: 640 } }))],
    ["parts", withClip(p, "a", (c) => ({ ...c, parts: [{ id: "p1", partId: "text", params: {} }] }))],
    ["emphasis", withClip(p, "a", (c) => ({ ...c, emphasis: { kind: "shadow" } }))],
    ["Swap card", withClip(p, "a", (c) => ({ ...c, cardId: "other" }))],
    ["Aspect ratio", { ...p, width: 1080, height: 1920 }],
    ["fps", { ...p, fps: 60 }],
    ["Theme", { ...p, themeId: "paper" }],
    ["style", { ...p, style: { accent: "#0f0" } }],
    ["3D field of view", { ...p, camera3dFov: 40 }],
  ];
  for (const [name, next] of differ) assert.notEqual(clipInputSig(next, "a"), sig, name);
  // 素材段的滤镜:库条目改了也变
  const vs = clipInputSig(p, "v");
  assert.notEqual(clipInputSig({ ...p, filters: [{ id: "f1", name: "blur", ops: [{ op: "blur", r: 5 }] }] }, "v"), vs);
  assert.notEqual(clipInputSig({ ...p, media: [{ ...p.media[0], hash: "e".repeat(64) }] }, "v"), vs, "Asset bytes changed");
  assert.equal(clipInputSig({ ...p, media: [{ ...p.media[0], url: "/@media/xyz" }] }, "v"), vs, "Asset URL rewriting (renderProject) does not count");
});

test("SIG-4 Media effect card: changing an upstream node or upstream clip changes the downstream; a cycle does not loop forever", () => {
  const p = project();
  const g = clipInputSig(p, "g");
  const upNode = { ...p, cardNodes: p.cardNodes.map((n) => (n.id === "n1" ? { ...n, params: { level: 2 } } : n)) };
  assert.notEqual(clipInputSig(upNode, "g"), g, "Upstream node parameters");
  const upClip = withClip(p, "v", (c) => ({ ...c, filter: { id: "f1", params: { r: 9 } } }));
  assert.notEqual(clipInputSig(upClip, "g"), g, "Filter parameters of the upstream clip (media clip)");
  const upMove = withClip(p, "v", (c) => ({ ...c, start: c.start + 1, end: c.end + 1 }));
  assert.notEqual(clipInputSig(upMove, "g"), g, "Upstream clip moved relative to this clip");
  const edge = { ...p, cardNodes: p.cardNodes.map((n) => (n.id === "n2" ? { ...n, inputs: { a: { nodeId: "n1", offset: 0.5 } } } : n)) };
  assert.notEqual(clipInputSig(edge, "g"), g, "Edge time mapping");
  // 环路:n1 ← n2 ← n1
  const cyc = { ...p, cardNodes: [
    { id: "n1", adapter: "card", cardId: "x", params: {}, inputs: { s: "n2" } },
    { id: "n2", adapter: "card", cardId: "y", params: {}, inputs: { s: "n1" } },
  ] };
  assert.match(clipInputSig(cyc, "g"), /^i1-/);
  // 片段自己引用自己
  const selfRef = { ...p, cardNodes: [{ id: "n2", adapter: "card", cardId: "y", params: {}, inputs: { s: "@clip/g/source" } }] };
  assert.match(clipInputSig(selfRef, "g"), /^i1-/);
});

test("SIG-5 Comparison: a missing signature or a different version is not judged stale; a clip not in the project returns null; the cached one is the same", () => {
  const p = project();
  const a = clipInputSig(p, "a");
  const b = clipInputSig(withClip(p, "a", (c) => ({ ...c, params: {} })), "a");
  assert.equal(inputSigStale(a, a), false);
  assert.equal(inputSigStale(a, b), true);
  assert.equal(inputSigStale(undefined, b), false, "Old layer map has no signature: apply as before");
  assert.equal(inputSigStale(a, null), false, "Page cannot compute it: apply as before");
  assert.equal(inputSigStale("i9-0000000000000000", b), false, "Different algorithm version: do not compare");
  assert.equal(clipInputSig(p, "nope"), null);
  assert.equal(clipInputSig(null, "a"), null);
  assert.equal(clipInputSig(withClip(p, "a", (c) => ({ ...c, params: { bad: Infinity } })), "a"), null, "Value that cannot be serialized: do not compare");
  assert.equal(cachedClipInputSig(p, "a"), a);
  assert.equal(cachedClipInputSig(p, "a"), a, "Second call hits the cache");
  assert.equal(cachedClipInputSig(null, "a"), null);
});

test("SIG-6 The inputSig written by layerMapOf matches the one computed by the page; clips not in the project are not written", () => {
  const p = project();
  const entry = {
    key: "entry1", project: structuredClone(p),
    cardPlan: [
      { clipId: "a", snapshotKey: "S".repeat(8), contentKey: "ck-a", tier: "shared", sampling: { firstFrame: 30 }, count: 90 },
      { clipId: "ghost", snapshotKey: "G".repeat(8), tier: "shared", sampling: { firstFrame: 0 }, count: 10 },
    ],
  };
  const body = layerMapOf(entry, { fingerprint: "f".repeat(16), now: 1 });
  const byId = Object.fromEntries(body.layers.map((l) => [l.clipId, l]));
  assert.equal(byId.a.inputSig, clipInputSig(p, "a"));
  assert.equal("inputSig" in byId.ghost, false, "Clip is not in this version of the project: not written");
  assert.equal(body.v, 3, "Do not add a version number (old pages read as before)");
  // 页面改了参数:层表里那一层就过期了
  const edited = withClip(p, "a", (c) => ({ ...c, params: { ...c.params, n: 4 } }));
  assert.equal(inputSigStale(byId.a.inputSig, clipInputSig(edited, "a")), true);
});

test("SIG-7 Node-side project processing (renderProject rewriting asset URLs, pipeline entry adding _frameSourceStamp to assets, structuredClone) does not change the signature", async () => {
  const { renderProject } = await import("../../server/render-project.mjs");
  const p = project();
  const nodeSide = structuredClone(renderProject(JSON.parse(JSON.stringify(p))));
  nodeSide.media = nodeSide.media.map((m) => ({ ...m, _frameSourceStamp: "stamp-1" }));
  for (const id of ["a", "g", "v"]) assert.equal(clipInputSig(nodeSide, id), clipInputSig(p, id), id);
});
