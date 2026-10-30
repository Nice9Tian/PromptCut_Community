/**
 * kernel/envelope.ts 的单测。跑:node --test src/kernel/envelope.test.mjs
 *
 * 封装是 Agent 和代码页看一张卡的唯一入口,读和写必须自洽:
 *   - 读出来的 parts 只带各自的参数,params 是全量,两边是同一份数据;
 *   - 写回只碰有差异的段,顺序固定;
 *   - 不合法的输入一处都不写(不留半截状态),错误信息说人话;
 *   - 只读段(world / motion / lifecycle)写了也不生效。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { envelopeOf, applyEnvelope, ENVELOPE_SCHEMA, describeLifecycle, rejectAudioVolumeKeys } from "./envelope.ts";

const STAGE = { width: 1920, height: 1080 };

const card = {
  id: "pin-board",
  name: "要点钉板",
  source: "native",
  description: "",
  defaults: { position: "left", accent: "", title: "SUMMARY", subtitle: "核心要点总结", items: "a|b|c", stepMs: 200 },
  controls: [
    { key: "position", label: "位置", type: "select", options: [{ value: "left", label: "l" }, { value: "center", label: "c" }] },
    { key: "accent", label: "主色", type: "color" },
    { key: "title", label: "小标题", type: "text" },
    { key: "subtitle", label: "副标题", type: "text" },
    { key: "items", label: "要点", type: "text" },
    { key: "stepMs", label: "间隔", type: "number" },
  ],
  parts: [
    { id: "title", label: "小标题", role: "text", params: ["title"], enterMs: 0, settleMs: 600 },
    { id: "subtitle", label: "副标题", role: "text", params: ["subtitle", "accent"], enterMs: 100, settleMs: 700 },
    { id: "items", label: "要点", role: "list", params: ["items", "stepMs"], enterMs: 300, settleMs: 1100 },
  ],
  lifecycle: { settleMs: 1100, after: "hold", exit: ["fade"] },
  Component: () => null,
};

function project(clip) {
  return { name: "p", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "t", media: [], tracks: [{ id: "t1", kind: "overlay", name: "序列 1", clips: [clip] }], cuts: [] };
}

function clipOf(extra = {}) {
  return { id: "c1", cardId: "pin-board", start: 2.4, end: 5.4, params: { ...card.defaults }, ...extra };
}

function recorder() {
  const calls = [];
  return {
    calls,
    writer: {
      setClipCard: (id, cardId) => calls.push(["card", id, cardId]),
      setClipParams: (id, params, opts) => calls.push(["params", id, params, opts]),
      moveClip: (id, patch) => calls.push(["time", id, patch]),
      setClipFrame: (id, frame) => calls.push(["frame", id, frame]),
      updateClip: (id, patch) => calls.push(["blend", id, patch]),
    },
  };
}

// validateCardParams 走的是全局注册表,测试里把这张卡注册进去
const { registerCards } = await import("./registry.ts");
registerCards([card]);

test("读:parts 只带自己的参数,params 全量,lifecycle 来自卡片,world 由 frame 算出", () => {
  const env = envelopeOf(project(clipOf()), clipOf(), card, STAGE);
  assert.equal(env.$schema, ENVELOPE_SCHEMA);
  assert.equal(env.card.lifecycle.settleMs, 1100);
  assert.deepEqual(env.time, { start: 2.4, end: 5.4, duration: 3 });
  assert.equal(env.frame.local, null);
  assert.equal(env.frame.world.w, 1920);
  assert.deepEqual(env.blend, { opacity: 1, fadeIn: 0, fadeOut: 0 });
  assert.equal(env.motion.attached, false);
  assert.deepEqual(env.parts.map((p) => p.id), ["title", "subtitle", "items"]);
  assert.deepEqual(env.parts[1].params, { subtitle: "核心要点总结", accent: "" });
  assert.equal(Object.keys(env.params).length, 6);
  assert.equal(env.missingParams, undefined);
  assert.match(describeLifecycle(env), /1\.1s 落定/);
  assert.match(describeLifecycle(env), /1\.9s 是静止/);
});

test("读:没声明 parts 的卡是一个根部件,所有参数都归它;老 clip 缺的参数列在 missingParams", () => {
  const bare = { ...card, id: "bare", parts: undefined, lifecycle: undefined };
  const clip = clipOf({ cardId: "bare", params: { title: "x" } });
  const env = envelopeOf(project(clip), clip, bare, STAGE);
  assert.equal(env.parts.length, 1);
  assert.equal(env.parts[0].id, "root");
  assert.deepEqual(env.parts[0].params, { title: "x" });
  assert.deepEqual(env.card.lifecycle, { after: "hold", exit: ["fade"] });
  assert.deepEqual(env.missingParams.sort(), ["accent", "items", "position", "stepMs", "subtitle"]);
});

test("写:原样传回去什么都不写;只改一段就只写那一段", () => {
  const clip = clipOf();
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r0 = recorder();
  assert.deepEqual(applyEnvelope(project(clip), "c1", env, card, STAGE, r0.writer, () => card).changed, []);
  assert.equal(r0.calls.length, 0);

  const r1 = recorder();
  const edited = JSON.parse(JSON.stringify(env));
  edited.blend.fadeOut = 0.4;
  edited.time.end = 3.6;
  const rep = applyEnvelope(project(clip), "c1", edited, card, STAGE, r1.writer, () => card);
  assert.deepEqual(rep.changed, ["time", "blend"]);
  assert.deepEqual(r1.calls, [["time", "c1", { start: 2.4, end: 3.6 }], ["blend", "c1", { fadeOut: 0.4 }]]);
});

test("写:blend 里塞音量当场拒并指向 set_clip_volume,一处都不写(以前回 changed: [] 像是成功了)", () => {
  const clip = clipOf();
  const r = recorder();
  assert.throws(
    () => applyEnvelope(project(clip), "c1", { blend: { volume: 0.3, fadeOut: 0.4 } }, card, STAGE, r.writer, () => card),
    /set_clip_volume/,
  );
  assert.equal(r.calls.length, 0);
});

test("update_clip 的参数:volume / audioVolume / gain 拒掉并指路,其余参数照常放行", () => {
  assert.throws(() => rejectAudioVolumeKeys({ clipId: "c1", volume: "0.3" }, "update_clip"), /update_clip.*set_clip_volume/);
  assert.throws(() => rejectAudioVolumeKeys({ clipId: "c1", audioVolume: 0.5 }, "update_clip"), /audioVolume/);
  assert.doesNotThrow(() => rejectAudioVolumeKeys({ clipId: "c1", opacity: 0.5, fadeIn: 1 }, "update_clip"));
  assert.doesNotThrow(() => rejectAudioVolumeKeys(undefined, "update_clip"));
});

test("写:改 parts 里的参数等于改 params;两边都给以 params 为准", () => {
  const clip = clipOf();
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r = recorder();
  const edited = JSON.parse(JSON.stringify(env));
  edited.parts[0].params.title = "TAKEAWAYS";
  assert.deepEqual(applyEnvelope(project(clip), "c1", edited, card, STAGE, r.writer, () => card).changed, ["params"]);
  assert.equal(r.calls[0][2].title, "TAKEAWAYS");
  assert.equal(r.calls[0][2].items, "a|b|c", "没改的参数原样带着");

  const r2 = recorder();
  applyEnvelope(project(clip), "c1", { params: { ...clip.params, title: "P" }, parts: edited.parts }, card, STAGE, r2.writer, () => card);
  assert.equal(r2.calls[0][2].title, "P");
});

test("写:frame.local 可写、world 只读;null 表示清掉框", () => {
  const clip = clipOf({ frame: { x: 100, y: 100, anchor: [0, 0] } });
  const r = recorder();
  applyEnvelope(project(clip), "c1", { frame: { local: { x: 200, y: 300, w: 640, h: 360, anchor: [0.5, 0.5], scale: 0.5 }, world: { x: 1 } } }, card, STAGE, r.writer, () => card);
  assert.deepEqual(r.calls, [["frame", "c1", { x: 200, y: 300, w: 640, h: 360, anchor: [0.5, 0.5], scale: 0.5 }]]);
  const r2 = recorder();
  applyEnvelope(project(clip), "c1", { frame: { local: null } }, card, STAGE, r2.writer, () => card);
  assert.deepEqual(r2.calls, [["frame", "c1", undefined]]);
});

test("写:任一处不合法整份不写,错误说人话", () => {
  const clip = clipOf();
  const bad = [
    [{ time: { end: 1 } }, /end > start/],
    [{ frame: { local: { x: 1 } } }, /x、y 必须是数字/],
    [{ frame: { local: { x: 1, y: 1, foo: 2 } } }, /不认识 "foo"/],
    [{ blend: { opacity: 2 } }, /0~1/],
    [{ card: { id: "nope" } }, /没有这张卡/],
    [{ params: { position: "top" } }, /只能是 left \/ center/],
    [{ params: { nope: 1 } }, /不是 pin-board 的参数/],
    [{ blend: { fadeIn: -1 }, time: { end: 9 } }, /不能为负/],
  ];
  for (const [input, re] of bad) {
    const r = recorder();
    assert.throws(() => applyEnvelope(project(clip), "c1", input, card, STAGE, r.writer, (id) => (id === "pin-board" ? card : undefined)), re, JSON.stringify(input));
    assert.equal(r.calls.length, 0, "不合法时一处都不该写:" + JSON.stringify(input));
  }
});

test("写:换卡先于写参数,新卡的参数按新卡校验", () => {
  const other = { ...card, id: "other-card", controls: [{ key: "text", label: "文字", type: "text", required: true }], defaults: { text: "" }, parts: undefined };
  registerCards([card, other]);
  const clip = clipOf();
  const r = recorder();
  const rep = applyEnvelope(project(clip), "c1", { card: { id: "other-card" }, params: { text: "hi" } }, card, STAGE, r.writer, (id) => (id === "other-card" ? other : card));
  assert.deepEqual(rep.changed, ["card", "params"]);
  assert.equal(r.calls[0][0], "card");
  assert.throws(() => applyEnvelope(project(clip), "c1", { card: { id: "other-card" } }, card, STAGE, recorder().writer, (id) => (id === "other-card" ? other : card)), /必填/);
});

test("时序随参数重算:条目多了落定就晚,静态值只是默认参数下的参考", () => {
  const timed = {
    ...card,
    id: "timed-card",
    timing: (p) => {
      const count = String(p.items).split("|").filter(Boolean).length;
      const settle = 300 + (count - 1) * Number(p.stepMs) + 400;
      return { settleMs: settle, parts: { items: { settleMs: settle } } };
    },
  };
  registerCards([card, timed]);
  const base = clipOf({ cardId: "timed-card" });
  const env0 = envelopeOf(project(base), base, timed, STAGE);
  assert.equal(env0.card.lifecycle.settleMs, 1100, "默认 3 条 × 200ms 和静态声明一致");
  const more = clipOf({ cardId: "timed-card", params: { ...card.defaults, items: "a|b|c|d|e|f", stepMs: 500 } });
  const env1 = envelopeOf(project(more), more, timed, STAGE);
  assert.equal(env1.card.lifecycle.settleMs, 300 + 5 * 500 + 400);
  assert.equal(env1.parts.find((p) => p.id === "items").settleMs, 300 + 5 * 500 + 400);
  assert.equal(env1.parts.find((p) => p.id === "title").settleMs, 600, "timing 没提到的部件保留静态值");
  // timing 算炸了不能把封装拖垮
  const broken = { ...timed, id: "broken-card", timing: () => { throw new Error("boom"); } };
  registerCards([card, broken]);
  const b = clipOf({ cardId: "broken-card" });
  assert.equal(envelopeOf(project(b), b, broken, STAGE).card.lifecycle.settleMs, 1100);
});

test("组合卡:parts 是实例树,带 partId / 画面位置 / 时序;写回整棵替换,只读段不影响", () => {
  const compositeCard = { id: "composite", name: "组合卡", source: "native", description: "", defaults: {}, controls: [], lifecycle: { after: "hold", exit: ["fade"] }, Component: () => null };
  registerCards([card, compositeCard]);
  const titlePart = {
    id: "text-title", name: "标题", description: "", role: "text",
    defaults: { text: "T", size: 48 }, controls: [{ key: "text", label: "标题", type: "text", required: true }, { key: "size", label: "字号", type: "number" }],
    defaultFrame: { x: 100, y: 100, w: 800, h: 160 }, settleMs: () => 600, after: "hold", Component: () => null,
  };
  const lookup = (id) => (id === "text-title" ? titlePart : undefined);
  const clip = { id: "c1", cardId: "composite", start: 0, end: 4, params: {}, frame: { x: 0, y: 0, w: 960, h: 540 },
    parts: [{ id: "a", partId: "text-title", params: { text: "Hi", size: 48 }, frame: { x: 100, y: 100, w: 800, h: 160 }, enterMs: 300 }] };
  const env = envelopeOf(project(clip), clip, compositeCard, STAGE, lookup);
  assert.equal(env.card.composite, true);
  assert.equal(env.card.lifecycle.settleMs, 900, "300 进场 + 600 落定");
  assert.equal(env.parts[0].partId, "text-title");
  assert.equal(env.parts[0].label, "标题");
  assert.deepEqual(env.parts[0].frame.local, { x: 100, y: 100, w: 800, h: 160 });
  assert.deepEqual(env.parts[0].frame.world, { left: 100, top: 100, width: 800, height: 160 }, "组合卡画布在 (0,0),缩放 1");
  assert.deepEqual(env.parts[0].params, { text: "Hi", size: 48 });

  // 原样写回:没改动
  const r0 = recorder(); r0.writer.setClipParts = (id, parts) => r0.calls.push(["parts", id, parts]);
  assert.deepEqual(applyEnvelope(project(clip), "c1", env, compositeCard, STAGE, r0.writer, (id) => (id === "composite" ? compositeCard : card), lookup).changed, []);

  // 改一个部件的参数和框、加一个部件
  const edited = JSON.parse(JSON.stringify(env));
  edited.parts[0].params.text = "Hello";
  edited.parts[0].frame.local = { x: 50, y: 60, w: 700, h: 120 };
  edited.parts[0].frame.world = { left: 999, top: 999, width: 1, height: 1 };
  edited.parts.push({ id: "b", partId: "text-title", params: { text: "Sub" }, enterMs: 500 });
  const r1 = recorder(); r1.writer.setClipParts = (id, parts) => r1.calls.push(["parts", id, parts]);
  const rep = applyEnvelope(project(clip), "c1", edited, compositeCard, STAGE, r1.writer, (id) => (id === "composite" ? compositeCard : card), lookup);
  assert.deepEqual(rep.changed, ["parts"]);
  const tree = r1.calls[0][2];
  assert.equal(tree[0].params.text, "Hello");
  assert.deepEqual(tree[0].frame, { x: 50, y: 60, w: 700, h: 120 }, "只有 local 写进去,world 忽略");
  assert.equal(tree[0].label, undefined, "部件名是显示用的,不存");
  assert.deepEqual(tree[1], { id: "b", partId: "text-title", params: { text: "Sub", size: 48 }, enterMs: 500 }, "新实例参数补齐默认值");

  // 坏树整份拒
  const bad = JSON.parse(JSON.stringify(env));
  bad.parts.push({ id: "a", partId: "text-title", params: {} });
  assert.throws(() => applyEnvelope(project(clip), "c1", bad, compositeCard, STAGE, recorder().writer, () => compositeCard, lookup), /重复/);
});

test("组合卡:嵌套的部件树原样写回不算改动(enterMs 保持相对父级),enterAtMs 是绝对时刻;缩过的组合卡里部件的画面位置按缩放后的框算", () => {
  const compositeCard = { id: "composite", name: "组合卡", source: "native", description: "", defaults: {}, controls: [], lifecycle: { after: "hold", exit: ["fade"] }, Component: () => null };
  const box = { id: "group-box", name: "组", description: "", role: "group", defaults: {}, controls: [], after: "hold", Component: () => null };
  const titlePart = { id: "text-title", name: "标题", description: "", role: "text", defaults: { text: "T" }, controls: [{ key: "text", label: "标题", type: "text" }], settleMs: () => 600, after: "hold", Component: () => null };
  const lookup = (id) => ({ "group-box": box, "text-title": titlePart })[id];
  registerCards([card, compositeCard]);
  const clip = { id: "c1", cardId: "composite", start: 0, end: 4, params: {},
    frame: { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5], scale: 0.5 },
    parts: [{ id: "g", partId: "group-box", params: {}, enterMs: 500, frame: { x: 100, y: 100, w: 800, h: 400 }, children: [{ id: "t", partId: "text-title", params: { text: "Hi" }, enterMs: 300 }] }] };
  const env = envelopeOf(project(clip), clip, compositeCard, STAGE, lookup);
  const g = env.parts[0], t = g.children[0];
  assert.equal(g.enterMs, 500); assert.equal(g.enterAtMs, 500);
  assert.equal(t.enterMs, 300, "写出去的还是相对父级的值"); assert.equal(t.enterAtMs, 800, "绝对时刻另给");
  assert.equal(t.settleMs, 1400);
  // 组合卡缩到一半绕中心:画布视觉框是 (480,270,960,540);g 的框 (100,100,800,400) 缩一半后落在 (530,320,400,200)
  assert.deepEqual(g.frame.world, { left: 530, top: 320, width: 400, height: 200 });
  assert.deepEqual(t.frame.world, g.frame.world, "没有框的子部件铺满父框");
  const r = recorder(); r.writer.setClipParts = (id, parts) => r.calls.push(["parts", id, parts]);
  assert.deepEqual(applyEnvelope(project(clip), "c1", env, compositeCard, STAGE, r.writer, () => compositeCard, lookup).changed, [], "往返一次一个字都不该写");
  // 连续两次往返,子实例的 enterMs 不漂
  const again = envelopeOf(project(clip), clip, compositeCard, STAGE, lookup);
  assert.equal(again.parts[0].children[0].enterMs, 300);
});

/*
 * 三维回归。ClipFrame 加了 rotateX / rotateY / translateZ,而这里的 FRAME_KEYS 白名单
 * 当初没同步 —— 后果不是「三维改不了」,是**这张卡的 set_clip 整个用不了**:
 * envelopeOf 把 frame 原样放进 frame.local,applyEnvelope 在 diff 之前就无条件校验它,
 * 于是哪怕只想改 params,只要封装里带着 frame 段就抛错。而错误信息会告诉 Agent
 * 「rotateY 不是合法的 frame 键」,它照做删掉,那张卡就被摆回平面了。
 */
test("三维:摆进空间的卡,封装原样传回不该报错", () => {
  for (const frame of [
    { x: 960, y: 540, anchor: [0.5, 0.5], rotateY: 30 },
    { x: 960, y: 540, anchor: [0.5, 0.5], rotateX: -12 },
    { x: 960, y: 540, anchor: [0.5, 0.5], translateZ: 200 },
    { x: 960, y: 540, anchor: [0.5, 0.5], rotateX: 5, rotateY: 30, translateZ: -80 },
  ]) {
    const clip = clipOf({ frame });
    const env = envelopeOf(project(clip), clip, card, STAGE);
    assert.deepEqual(env.frame.local, frame, "读出来的 local 要原样带着三维那几项");
    const r = recorder();
    // 原样传回 = 什么都没改,changed 应该是空的,更不能抛
    assert.deepEqual(
      applyEnvelope(project(clip), "c1", env, card, STAGE, r.writer, () => card).changed,
      [],
      `frame=${JSON.stringify(frame)} 原样传回不该有改动`,
    );
  }
});

test("三维:能通过 set_clip 把卡摆进空间,也能改回来", () => {
  const clip = clipOf({ frame: { x: 960, y: 540, anchor: [0.5, 0.5] } });
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r = recorder();
  const edited = { ...env, frame: { ...env.frame, local: { ...env.frame.local, rotateY: 25, translateZ: 120 } } };
  const rep = applyEnvelope(project(clip), "c1", edited, card, STAGE, r.writer, () => card);
  assert.deepEqual(rep.changed, ["frame"]);
  const wrote = r.calls.find((c) => c[0] === "frame");
  assert.equal(wrote[2].rotateY, 25);
  assert.equal(wrote[2].translateZ, 120);
});

test("三维:frame.local 里的三维项必须是数字", () => {
  const clip = clipOf({ frame: { x: 960, y: 540 } });
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r = recorder();
  const bad = { ...env, frame: { ...env.frame, local: { x: 960, y: 540, rotateY: "很多" } } };
  assert.throws(
    () => applyEnvelope(project(clip), "c1", bad, card, STAGE, r.writer, () => card),
    /frame\.local\.rotateY 要是数字/,
  );
});

/*
 * 素材段的三维:set_clip 这条路也要拦住。
 *
 * set_position 那边先加了拦截,但 set_clip 是另一条路 —— get_clip 拿到封装、
 * 往 frame.local 里塞一个 rotateY 再写回来,照样能写进去(审查时实测能写进去)。
 * 凡是能改 frame 的路都会经过 applyEnvelope,规则放在那儿才是真守住。
 */
test("素材段:set_clip 也不能把三维塞进 frame", () => {
  const mediaClip = { id: "m1", mediaId: "v1", start: 0, end: 3, frame: { x: 960, y: 540, w: 1920, h: 1080 } };
  const proj = { name: "p", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "t", media: [{ id: "v1", url: "x", kind: "video" }], tracks: [{ id: "t1", kind: "overlay", name: "序列 1", clips: [mediaClip] }], cuts: [] };
  const env = envelopeOf(proj, mediaClip, undefined, STAGE);
  const r = recorder();
  const edited = { ...env, frame: { ...env.frame, local: { ...env.frame.local, rotateY: 35 } } };
  assert.throws(
    () => applyEnvelope(proj, "m1", edited, undefined, STAGE, r.writer, () => undefined),
    /只对卡片生效/,
  );
  // 拦下来就一个字都不该写
  assert.equal(r.calls.length, 0);
});

test("素材段:平面的位置 / 大小 / 旋转照常能改", () => {
  const mediaClip = { id: "m1", mediaId: "v1", start: 0, end: 3, frame: { x: 960, y: 540, w: 1920, h: 1080 } };
  const proj = { name: "p", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "t", media: [{ id: "v1", url: "x", kind: "video" }], tracks: [{ id: "t1", kind: "overlay", name: "序列 1", clips: [mediaClip] }], cuts: [] };
  const env = envelopeOf(proj, mediaClip, undefined, STAGE);
  const r = recorder();
  const edited = { ...env, frame: { ...env.frame, local: { ...env.frame.local, x: 500, rotate: 12 } } };
  assert.deepEqual(applyEnvelope(proj, "m1", edited, undefined, STAGE, r.writer, () => undefined).changed, ["frame"]);
});

test("卡片段:三维照常能通过 set_clip 写进去(拦截只针对素材)", () => {
  const clip = clipOf({ frame: { x: 960, y: 540, anchor: [0.5, 0.5] } });
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r = recorder();
  const edited = { ...env, frame: { ...env.frame, local: { ...env.frame.local, rotateY: 35 } } };
  assert.deepEqual(applyEnvelope(project(clip), "c1", edited, card, STAGE, r.writer, () => card).changed, ["frame"]);
});
