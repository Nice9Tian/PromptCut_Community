/**
 * node --test src/ai/envReport.test.mjs
 *
 * 诊断报告里的「环境快照」。
 *
 * 它守的不是某个算法,是**一份清单**:模式、项目路径、素材库、后端会话 id。
 * 少一项的代价不是崩溃,而是又一轮来回问用户 —— 也就是这份报告存在的全部理由落空。
 * 所以下面每条测试都对着一个「漏了它就查不下去」的字段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildEnvReport, describeMode, mediaDirs } = await import("./envReport.ts");

function store(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
  };
}

const base = { project: null };

test("两种工作方式都要说得出人话;对话式布局已去掉,旧报告里的 layout 字段不影响", () => {
  assert.equal(describeMode({}), "传统式");
  assert.equal(describeMode({ layout: "chat" }), "传统式");
  assert.match(describeMode({ skill: { active: true } }), /SKILL/);
  assert.doesNotMatch(describeMode({ skill: { active: true } }), /对话式|只读/);
  assert.match(describeMode({ agentTabs: 3 }), /多 Agent\(3 个页签\)/);
  assert.equal(describeMode({ agentTabs: 1 }), "传统式");
});

test("没保存过的项目要**显式**说出来 —— 素材在临时目录的怪事都是从这儿来的", () => {
  const r = buildEnvReport({ ...base, project: { name: "未命名", filePath: null, media: [], tracks: [] } });
  assert.equal(r.project.saved, false);
  assert.match(r.project.savedNote, /临时目录/);

  const saved = buildEnvReport({ ...base, project: { name: "x", filePath: "D:\\片子\\a.proc", media: [], tracks: [] } });
  assert.equal(saved.project.saved, true);
  assert.equal(saved.project.savedNote, undefined, "存过盘就不该再挂那句提示");
  assert.equal(saved.project.filePath, "D:\\片子\\a.proc");
});

test("素材库是空的时候要写在报告里 —— 模型说得出名字就是对质证据", () => {
  const r = buildEnvReport({ ...base, project: { media: [], tracks: [] } });
  assert.equal(r.media.count, 0);
  assert.match(r.media.说明, /空的/);
});

test("素材要报到文件一级,还要单列它们在哪些目录", () => {
  const media = [
    { id: "m1", name: "a.mp4", kind: "video", duration: 12, path: "C:\\Temp\\promptcut\\work\\a.mp4" },
    { id: "m2", name: "b.mp4", kind: "video", path: "C:\\Temp\\promptcut\\work\\b.mp4" },
    { id: "m3", name: "c.wav", kind: "audio", path: "D:\\素材\\c.wav" },
  ];
  const r = buildEnvReport({ ...base, project: { media, tracks: [] } });
  assert.equal(r.media.count, 3);
  assert.deepEqual(r.media.items.map((m) => m.name), ["a.mp4", "b.mp4", "c.wav"]);
  assert.deepEqual(mediaDirs(media).sort(), ["C:\\Temp\\promptcut\\work", "D:\\素材"]);
  assert.deepEqual(r.media.dirs.sort(), ["C:\\Temp\\promptcut\\work", "D:\\素材"]);
});

test("没有磁盘路径的素材不能只是缺个字段,要说清是什么情况", () => {
  const r = buildEnvReport({ ...base, project: { media: [{ id: "m", name: "x", kind: "video" }], tracks: [] } });
  assert.match(r.media.items[0].path, /blob/);
});

test("可见 0 条 + 会话 id 还在 = 后端接着旧历史,两个数必须摆在一起", () => {
  const r = buildEnvReport({
    ...base,
    visibleMessages: 0,
    storage: store({ "aiSession:api": "api-9433c3ac", aiProvider: "api" }),
  });
  assert.equal(r.chat.visibleMessages, 0);
  assert.deepEqual(r.chat.backendSessionIds, { "aiSession:api": "api-9433c3ac" });
  assert.match(r.chat.说明, /1 把/);
  assert.deepEqual(r.localSettings, { aiProvider: "api" }, "会话 id 不该同时混进偏好那一段");
});

test("干净起步时也要说清「就是干净的」,而不是留一个空对象让人猜", () => {
  const r = buildEnvReport({ ...base, visibleMessages: 0, storage: store({ aiProvider: "api" }) });
  assert.deepEqual(r.chat.backendSessionIds, {});
  assert.match(r.chat.说明, /从零开始/);
});

test("用户写的剧本正文不许进报告 —— 这份报告是要上传的", () => {
  /*
   * pc.ai.script 存的是用户手写的剧本(ai/script.ts)。原来这里按 `ai*` / `pc.*`
   * 前缀通配收值,于是剧本前 200 字静默进了要上传的报告(ai/reportSubmit.ts)。
   * 通配还意味着将来任何新加的同前缀键都会自动跟着外发,加键的人不会想到这一层。
   */
  const 剧本 = "第一幕:主角喝完野生狗奶,直接化身快乐小狗,镜头推近";
  const r = buildEnvReport({ ...base, storage: store({ "pc.ai.script": 剧本 }) });
  const dumped = JSON.stringify(r);
  assert.ok(!dumped.includes("快乐小狗"), `剧本正文漏进报告了:${dumped}`);
  assert.match(r.localSettings["pc.ai.script"], /有值/, "但要让人知道有这么个键");
  assert.match(r.localSettings["pc.ai.script"], new RegExp(`共 ${剧本.length} 字`), "长度要报出来");
});

test("白名单里的纯设置项照旧带值 —— 不然排查时什么也看不出来", () => {
  const r = buildEnvReport({
    ...base,
    storage: store({ aiProvider: "api", aiShowThinking: "1", "pc.volume": "0.5", "pc.ai.effort.codex": "high" }),
  });
  assert.deepEqual(r.localSettings, {
    aiProvider: "api",
    aiShowThinking: "1",
    "pc.volume": "0.5",
    "pc.ai.effort.codex": "high",
  });
});

test("没见过的同前缀新键默认不带原文 —— 加键的人不必记得这条规矩", () => {
  const r = buildEnvReport({ ...base, storage: store({ "pc.某个以后才加的键": "谁知道里面装了什么" }) });
  assert.ok(!JSON.stringify(r).includes("谁知道"), "白名单外的一律不带原文");
});

test("跟我们无关的键一个都不收", () => {
  const r = buildEnvReport({ ...base, storage: store({ "some-other-app": "x", token: "abc" }) });
  assert.deepEqual(r.localSettings, {});
});

test("长值要截断:一条草稿能把整份报告顶爆", () => {
  const r = buildEnvReport({ ...base, storage: store({ aiProvider: "x".repeat(5000) }) });
  assert.ok(r.localSettings.aiProvider.length < 300);
  assert.match(r.localSettings.aiProvider, /共 5000 字/);
});
test("读不到 localStorage 时报一句话,不许整份报告跟着挂", () => {
  const r = buildEnvReport({ ...base, storage: null });
  assert.match(r.localNote, /读不到/);
  assert.deepEqual(r.chat.backendSessionIds, {});
});

test("序列只报条数,不把整条时间轴塞进报告", () => {
  const r = buildEnvReport({
    ...base,
    project: { media: [], tracks: [{ id: "t-1", name: "序列 1", clips: [{}, {}] }, { id: "t-2", clips: [] }] },
  });
  assert.deepEqual(r.project.tracks, [
    { id: "t-1", name: "序列 1", clips: 2 },
    { id: "t-2", name: undefined, clips: 0 },
  ]);
  assert.equal(r.project.clipCount, 2);
});

test("posix 根目录下的素材,目录就是根,不是「没有目录」", () => {
  assert.deepEqual(mediaDirs([{ id: "m", name: "a.mp4", kind: "video", path: "/a.mp4" }]), ["/"]);
});
