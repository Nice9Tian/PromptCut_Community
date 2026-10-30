/**
 * HR24：项目设置里「托管方的渲染节点」的勾选与成员列表里的服务行（契约 `docs/plan/hosted-render-contract.md` 第 1.7、3、10.1 节）。
 *
 *   node --test src/editor/sync/hostedServices.test.mjs
 *
 *   HR24a 纯逻辑：成员列表顶层 `hosted` 的解析；显示条件（放云端且 `available`）；`hosted-service-changed` 落到状态上；
 *         成员列表拆成成员与服务行（服务行在后、不计数）
 *   HR24b 组件：放本机、没有 `hosted` 字段、`available` 为假时没有这一项；放云端且 `available` 时出现，缺省勾上；
 *         创建者能改（勾选没有 disabled）、其他成员只读（disabled，另有「只有创建者能改」）；点勾选把「要改成什么」交给上层
 *   HS10～HS12：渲染节点下面的子选项「生成轨道流」（见文件末尾）
 *   HS13：账号项目那条路（状态从会话里来、没有创建者密码这一步、成员靠前后两次读到的状态得到提示）
 *   同步管理（`syncManager.ts`）把成员列表的 `hosted` 与 `hosted-service-changed` 通知接到上面两个纯函数；它在 Node 里载不起来（要浏览器环境），
 *   那一段在浏览器里验（报告里的两张截图与断言）。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const H = await import(srcUrl("editor/sync/hostedServices.ts"));

const ON = { render: { available: true, enabled: true }, agent: { available: false, enabled: true } };
const OFF = { render: { available: true, enabled: false } };

test("HR24a 解析 hosted:形状对才收;没有这个字段(放本机、旧托管端)是 null", () => {
  assert.equal(H.parseHosted(undefined), null);
  assert.equal(H.parseHosted(null), null);
  assert.equal(H.parseHosted([]), null);
  assert.equal(H.parseHosted({}), null);
  assert.equal(H.parseHosted({ render: { available: "yes", enabled: true } }), null, "available 不是布尔值不收");
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: false }, junk: 1 }), { render: { available: true, enabled: false } });
  assert.deepEqual(H.parseHosted(ON), ON);
});

test("HR24a 显示条件:只有放云端且 available 才有这一行;缺省勾上(记录里没有算开)", () => {
  assert.deepEqual(H.hostedRowsOf("hosted", ON), [{ service: "render", label: "托管方的渲染节点", enabled: true }]);
  assert.deepEqual(H.hostedRowsOf("hosted", OFF), [{ service: "render", label: "托管方的渲染节点", enabled: false }]);
  assert.deepEqual(H.hostedRowsOf("lan", ON), [], "放本机的项目没有这一项");
  assert.deepEqual(H.hostedRowsOf(null, ON), []);
  assert.deepEqual(H.hostedRowsOf("hosted", null), [], "没有 hosted 字段(旧托管端)没有这一项");
  assert.deepEqual(H.hostedRowsOf("hosted", { render: { available: false, enabled: true } }), [], "登记表里没有这个服务");
  assert.deepEqual(H.hostedRowsOf("hosted", { agent: { available: true, enabled: true } }), [{ service: "agent", label: "云端 Agent", enabled: true }], "云端 Agent 一行:托管端有这个服务才出现,缺省勾上");
  assert.deepEqual(H.hostedRowsOf("hosted", { render: { available: true, enabled: true }, agent: { available: true, enabled: false } }).map((r) => [r.service, r.enabled]), [["render", true], ["agent", false]], "两行都在,渲染节点在前");
  assert.deepEqual(H.hostedRowsOf("lan", { agent: { available: true, enabled: true } }), [], "放本机的项目没有云端 Agent 一行");
});

test("CAU-SW-01 云端 Agent 一行的文案与同组一致;成员行下的云端 Agent 连接与署名", () => {
  const t = H.HOSTED_SERVICE_TEXT.agent;
  assert.equal(t.label, "云端 Agent");
  for (const on of [true, false]) for (const f of [t.hint, t.confirm]) assert.ok(f(on).length > 8);
  assert.ok(t.changed(false).length > 8);
  assert.equal(t.changed(true), "", "只在关闭时给别的成员气泡,打开时不提示〔用户 2026-10-07 定〕");
  assert.equal(H.HOSTED_SERVICE_TEXT.render.changed(true), "", "渲染节点同一个规矩:只在关闭时给别的成员气泡,打开时不提示〔用户 2026-10-07 定〕");
  assert.match(H.HOSTED_SERVICE_TEXT.render.changed(false), /创建者关闭了托管方的渲染节点/);
  assert.match(t.hint(false), /已关闭/);
  assert.match(t.changed(false), /创建者关闭了云端 Agent/);
  assert.notEqual(H.HOSTED_SERVICE_TEXT.render.confirm(false), t.confirm(false), "确认弹窗的话按服务各写各的");
  const conns = [{ role: "page" }, { role: "agent", conversation: 2 }, { role: "agent", conversation: "cc-1", service: "agent" }];
  assert.deepEqual(H.cloudAgentConns(conns), [{ role: "agent", conversation: "cc-1", service: "agent" }]);
  assert.equal(H.cloudAgentLabel("alice"), "alice的云端 Agent");
});

test("HR24a 通知落到状态上:认得的服务才改;不认识或这个项目没有这项服务就原样", () => {
  assert.deepEqual(H.applyHostedChange(ON, "render", false), { ...ON, render: { available: true, enabled: false } });
  assert.equal(H.applyHostedChange(ON, "nope", false), ON);
  assert.equal(H.applyHostedChange(ON, "render", "no"), ON);
  assert.equal(H.applyHostedChange(null, "render", false), null);
  assert.equal(H.applyHostedChange({ agent: { available: true, enabled: true } }, "render", false).render, undefined, "没有 render 这一项就不凭空造出来");
});

test("HR24a 成员列表:服务行在成员之后、不计入成员数;服务名不看用户名", () => {
  const row = (username, extra = {}) => ({ username, displayName: username, deviceId: `${username}-d`, deviceName: null, creator: false, tags: { editing: false, rendering: false, agents: 0 }, conns: [], ...extra });
  const rows = [row("service:render", { service: "render", conns: [{ role: "render" }] }), row("bob"), row("alice", { creator: true })];
  const { people, services } = H.splitMembers(rows);
  assert.deepEqual(people.map((r) => r.username), ["bob", "alice"]);
  assert.deepEqual(services.map((r) => r.service), ["render"]);
  assert.equal(H.serviceRowLabel("render"), "托管方的渲染节点");
  assert.equal(H.serviceRowLabel("something-else"), "托管方的服务");
  assert.equal(H.serviceRowLabel(undefined), "托管方的服务");
});

/** 渲染 HostedServiceRows(TSX 经 vite 的 ssrLoadModule 载入,与 stageLocalOnly.test.mjs 同一做法) */
async function withRows(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const M = await server.ssrLoadModule("/src/editor/sync/HostedServiceRows.tsx");
    const render = (props) => renderToStaticMarkup(React.createElement(M.HostedServiceRows, { onToggle: () => {}, ...props }));
    await fn({ M, render });
  } finally {
    await server.close();
  }
}

const checkboxOf = (html) => html.match(/<input[^>]*data-pc="collab-hosted-render-toggle"[^>]*>/)?.[0] ?? null;

test("HR24b 没有这一项的情况:放本机、没有 hosted 字段、available 为假", () => withRows(({ render }) => {
  assert.equal(render({ where: "lan", hosted: ON, creator: true }), "");
  assert.equal(render({ where: "hosted", hosted: null, creator: true }), "");
  assert.equal(render({ where: "hosted", hosted: { render: { available: false, enabled: true } }, creator: true }), "");
}));

test("HR24b 放云端且 available:出现,缺省勾上;创建者能改,成员只读", () => withRows(({ render }) => {
  const asCreator = render({ where: "hosted", hosted: ON, creator: true });
  assert.match(asCreator, /托管方的渲染节点/);
  const box = checkboxOf(asCreator);
  assert.ok(box, "有勾选框");
  assert.match(box, /checked=""/, "缺省勾上");
  assert.doesNotMatch(box, /disabled/, "创建者可以改");
  assert.doesNotMatch(asCreator, /只有创建者能改/);

  const asMember = render({ where: "hosted", hosted: ON, creator: false });
  const memberBox = checkboxOf(asMember);
  assert.match(memberBox, /checked=""/);
  assert.match(memberBox, /disabled=""/, "成员只读");
  assert.match(asMember, /只有创建者能改/);

  const closed = render({ where: "hosted", hosted: OFF, creator: true });
  assert.doesNotMatch(checkboxOf(closed), /checked/, "关掉后不勾");
  assert.match(closed, /已关闭/);

  const busy = render({ where: "hosted", hosted: ON, creator: true, busy: true });
  assert.match(checkboxOf(busy), /disabled=""/, "忙的时候创建者也不能再点");
}));

test("HR24b 点勾选:把要改成什么交给上层(创建者身份验证由上层的 CreatorFlow 做)", () => withRows(({ M }) => {
  // 直接取元素树里勾选框的 onChange,不起 DOM
  const tree = M.HostedServiceRows({ where: "hosted", hosted: ON, creator: true, onToggle: (...a) => calls.push(a) });
  const calls = [];
  const find = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.type === "input") return node;
    const kids = React.Children.toArray(node.props?.children);
    for (const k of kids) { const r = find(k); if (r) return r; }
    return null;
  };
  const input = find(tree);
  assert.ok(input, "找得到勾选框");
  input.props.onChange({ target: { checked: false } });
  input.props.onChange({ target: { checked: true } });
  assert.deepEqual(calls, [["render", false], ["render", true]]);
}));

/* ---------------- 第四段:项目设置里「云端 Agent」一行、署名(契约 `docs/plan/cloud-agent-contract.md` 第 5、9.5 节) ---------------- */

const agentBoxOf = (html) => html.match(/<input[^>]*data-pc="collab-hosted-agent-toggle"[^>]*>/)?.[0] ?? null;

test("CAU-SW-02 项目设置里「云端 Agent」一行:放云端且 hosted.agent.available 才出现,缺省勾上;创建者能改,成员只读", () => withRows(({ render }) => {
  const BOTH = { render: { available: true, enabled: true }, agent: { available: true, enabled: true } };
  assert.equal(agentBoxOf(render({ where: "hosted", hosted: ON, creator: true })), null, "这台托管端没有云端 Agent(available 为假):没有这一行");
  assert.equal(render({ where: "lan", hosted: BOTH, creator: true }), "", "放本机的项目没有");
  const asCreator = render({ where: "hosted", hosted: BOTH, creator: true });
  assert.match(asCreator, /云端 Agent/);
  assert.match(asCreator, /AI 栏里选「云端」/, "有一行说明");
  assert.match(agentBoxOf(asCreator), /checked=""/, "缺省勾上");
  assert.doesNotMatch(agentBoxOf(asCreator), /disabled/, "创建者可以改");
  assert.ok(asCreator.indexOf("托管方的渲染节点") < asCreator.indexOf("云端 Agent"), "与渲染节点的开关放在一起,在它后面");
  const asMember = render({ where: "hosted", hosted: BOTH, creator: false });
  assert.match(agentBoxOf(asMember), /disabled=""/, "成员只读");
  const closed = render({ where: "hosted", hosted: { ...BOTH, agent: { available: true, enabled: false } }, creator: false });
  assert.doesNotMatch(agentBoxOf(closed), /checked/);
  assert.match(closed, /已关闭:成员不能再用云端 Agent|已关闭：成员不能再用云端 Agent/);
}));

test("CAU-SIGN-01 署名:云端 Agent 的改动别人看到「〈成员名〉的云端 Agent」,发起的设备上是「你的云端 Agent」;本机 Agent 的说法不变", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const L = await server.ssrLoadModule("/src/editor/sync/labels.ts");
    const bob = { session: "s-bob", userId: "bob@dev-b" };
    const cloud = { userId: "alice@dev-a", deviceId: "dev-a", role: "agent", conversation: 3, session: "s-agent", service: "agent" };
    // 两种形状都认:DocSync 记的 { actor, session },与文档服务直接给的 actor 本身
    assert.equal(L.writerLabel({ actor: cloud, session: "s-agent" }, bob), "alice的云端 Agent");
    assert.equal(L.writerLabel(cloud, bob), "alice的云端 Agent");
    // 发起成员不在线(成员列表里查不到显示名)时照样有名字;在线、重名带设备名时也只用用户名
    assert.equal(L.writerLabel({ actor: cloud }, bob, new Map([["alice@dev-a", "alice (电脑)"]])), "alice的云端 Agent");
    // 用户名里带 @ 的:取最后一个 @ 之前
    assert.equal(L.writerLabel({ actor: { ...cloud, userId: "a@b@dev-a" } }, bob), "a@b的云端 Agent");
    // 发起的那台设备上
    assert.equal(L.writerLabel({ actor: cloud }, { session: "s-alice", userId: "alice@dev-a" }), "你的云端 Agent");
    // 同一位成员在另一台设备上看:按名字说
    assert.equal(L.writerLabel({ actor: cloud }, { session: "s-alice-2", userId: "alice@dev-a2" }), "alice的云端 Agent");
    // 本机 Agent 的说法不变
    const local = { userId: "alice@dev-a", deviceId: "dev-a", role: "agent", conversation: 2, session: "s-x" };
    assert.equal(L.writerLabel({ actor: { ...local, username: "alice" } }, bob, new Map([["alice@dev-a", "alice"]])), "alice · Agent · 第 2 个对话");
    assert.equal(L.writerLabel({ actor: local }, bob), "Agent「第 2 个对话」");
    assert.equal(L.writerLabel({ actor: local }, { session: "s-alice", userId: "alice@dev-a" }), "Agent「第 2 个对话」");
    assert.equal(L.writerLabel({ actor: { userId: "alice@dev-a", role: "page", session: "s-p" } }, bob, new Map([["alice@dev-a", "alice"]])), "alice");
  } finally {
    await server.close();
  }
});

const mrow = (username, conns, extra = {}) => ({ username, displayName: username, deviceId: `${username}-d`, deviceName: null, creator: false, tags: { editing: conns.some((c) => c.role === "page"), rendering: false, agents: conns.filter((c) => c.role === "agent").length }, conns, ...extra });

/** 「有一轮在跑」表:成员键是 用户名@设备号(与成员行的 `${username}@${deviceId}` 同一写法,mrow 的设备号是 `<用户名>-d`) */
const running = (...names) => new Set(names.map((n) => `${n}@${n}-d`));
const NONE = new Set();

test("CAU-MEM-01 成员计数口径〔用户 2026-10-07 定,同日改按「一轮在跑」〕:人数只算真人在线;Agent 数 = 本机 + 有一轮在跑的云端;离线只剩闲置云端连接的不显示", () => {
  const alice = mrow("alice", [{ role: "page" }, { role: "agent", conversation: 1 }, { role: "agent", conversation: 2 }]);
  const bob = mrow("bob", [{ role: "page" }, { role: "agent", conversation: "cc-1", service: "agent" }, { role: "agent", conversation: "cc-1", service: "agent" }]);
  const carol = mrow("carol", [{ role: "agent", conversation: "cc-2", service: "agent" }]);
  const render = mrow("service:render", [{ role: "render" }], { service: "render" });
  const { people } = H.splitMembers([alice, bob, carol, render]);
  assert.equal(people.length, 3, "渲染节点那一行不进成员");
  // 谁都没有一轮在跑:bob 的云端 Agent 闲置(不计),carol 本人不在线、只剩闲置连接(整行不显示、不计)
  assert.deepEqual(H.memberCounts(people, NONE), { people: 2, agents: 2 }, "只剩 alice 的本机 Agent 2 个;bob、carol 的云端连接都闲置,不计");
  assert.deepEqual(H.visibleMembers(people, NONE).map((r) => r.username), ["alice", "bob"], "carol 本人不在线、只剩闲置的云端 Agent 连接:这一行不显示");
  assert.equal(H.memberCountLabel(people, NONE), "成员：2 人 · Agent：2 个");
  assert.equal(H.isCloudAgentOnly(carol, NONE), false, "闲置的不标「离线,Agent 在跑」");
  assert.equal(H.isIdleCloudAgentOnly(carol, NONE), true);
  assert.equal(H.isCloudAgentRunning(bob, NONE), false, "本人在线、云端 Agent 闲置:不显示「[云端 Agent]」标记");
  // bob、carol 各有一轮在跑:bob 云端算 1 个(多条连接只算一个),carol 的行回来、标「离线,Agent 在跑」、计入 Agent 数、不计入人数
  const both = running("bob", "carol");
  assert.deepEqual(H.memberCounts(people, both), { people: 2, agents: 4 }, "真人在线 alice、bob;Agent:alice 本机 2 个 + bob 云端 1 个 + carol 云端 1 个");
  assert.equal(H.memberCountLabel(people, both), "成员：2 人 · Agent：4 个");
  assert.deepEqual(H.visibleMembers(people, both).map((r) => r.username), ["alice", "bob", "carol"]);
  assert.equal(H.isPersonOnline(alice), true);
  assert.equal(H.isPersonOnline(carol), false);
  assert.equal(H.isCloudAgentOnly(carol, both), true, "本人不在线、云端 Agent 有一轮在跑:标「离线,Agent 在跑」");
  assert.equal(H.isCloudAgentOnly(bob, both), false, "本人在线的不标");
  assert.equal(H.isCloudAgentRunning(bob, both), true, "本人在线、一轮在跑:显示「[云端 Agent]」标记");
  assert.equal(H.isCloudAgentOnly(alice, both), false);
  assert.equal(H.isCloudAgentOnly(mrow("dave", []), running("dave")), false, "没有任何连接不算");
  // 表里有这位成员、但他名下并没有云端 Agent 的连接(成员列表还没跟上):不算
  assert.equal(H.isCloudAgentRunning(alice, running("alice")), false, "没有云端 Agent 连接,表里有也不算");
  assert.equal(H.memberKeyOf(alice), "alice@alice-d", "成员键是 用户名@设备号");
});

test("CAU-MEM-02 成员计数:只有自己在线时是「成员:1 人 · Agent:0 个」;自己带本机 Agent、一轮在跑的云端 Agent 都计入 Agent;自己那一行也按这张表", () => {
  assert.equal(H.memberCountLabel([], NONE), "成员：1 人 · Agent：0 个", "自己总是在线,人数至少 1");
  const me = mrow("me", [{ role: "page" }]);
  assert.equal(H.memberCountLabel([me], NONE), "成员：1 人 · Agent：0 个");
  const me2 = mrow("me", [{ role: "page" }, { role: "agent", conversation: 1 }, { role: "agent", conversation: "cc-9", service: "agent" }]);
  assert.equal(H.memberCountLabel([me2], NONE), "成员：1 人 · Agent：1 个", "自己的云端 Agent 闲置:只算本机的 1 个");
  assert.equal(H.memberCountLabel([me2], running("me")), "成员：1 人 · Agent：2 个", "自己的云端 Agent 有一轮在跑:本机 1 + 云端 1");
  assert.equal(H.isCloudAgentRunning(me2, running("me")), true, "自己那一行也按这张表显示「[云端 Agent]」");
  assert.equal(H.isCloudAgentRunning(me2, NONE), false);
  // 只有自己的云端 Agent 连着(自己的页面都关了):闲置时整行不显示、不计;一轮在跑时标「离线,Agent 在跑」、计 Agent、不计人数
  const gone = mrow("gone", [{ role: "agent", conversation: "cc-3", service: "agent" }]);
  assert.equal(H.memberCountLabel([me, gone], NONE), "成员：1 人 · Agent：0 个");
  assert.equal(H.memberCountLabel([me, gone], running("gone")), "成员：1 人 · Agent：1 个");
  assert.equal(H.isCloudAgentOnly(gone, running("gone")), true);
});

/* ---------------- 渲染节点下面的子选项「生成轨道流」(契约 `docs/plan/hosted-render-contract.md` 第 3.1 节;用例前缀 HS 是「轨道流入口」) ----------------
 *   HS10 纯逻辑:解析、出现条件、置灰条件、通知落到状态上、文案
 *   HS11 组件:出现位置(渲染节点那一行下面)、缺省勾上、创建者能改/成员只读、渲染节点关着时置灰、点勾选交给上层
 *   HS12 向后兼容:旧托管端不报 streams(这一行不显示,别的行不变);新托管端多出的字段不影响别的行
 */
const WITH_STREAMS = { render: { available: true, enabled: true, streams: true }, agent: { available: false, enabled: true } };
const STREAMS_OFF = { render: { available: true, enabled: true, streams: false } };
const RENDER_OFF = { render: { available: true, enabled: false, streams: true } };

test("HS10 解析 hosted:streams 是布尔才收;非布尔丢掉但这个服务照收;云端 Agent 上的 streams 不收;streamsAllowed 照收", () => {
  assert.deepEqual(H.parseHosted(WITH_STREAMS), WITH_STREAMS);
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: true, streams: false } }), STREAMS_OFF);
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: true, streams: false, streamsAllowed: false } }), { render: { available: true, enabled: true, streams: false, streamsAllowed: false } });
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: true, streams: "yes" } }), { render: { available: true, enabled: true } }, "streams 不是布尔值:只丢这一项");
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: true, streams: null } }), { render: { available: true, enabled: true } });
  assert.deepEqual(H.parseHosted({ agent: { available: true, enabled: true, streams: true } }), { agent: { available: true, enabled: true } }, "只有渲染节点有这一项");
});

test("HS10 出现条件:放云端、render.available、文档服务报了 streams(旧托管端不报就不出现);缺省关(记录里没有算关,由文档服务算好再报,页面只照报的值显示)", () => {
  const opt = (enabled, parentOff = false) => [{ service: "render", option: "streams", label: "生成轨道流", enabled, parentOff }];
  assert.deepEqual(H.hostedOptionRowsOf("hosted", WITH_STREAMS), opt(true));
  assert.deepEqual(H.hostedOptionRowsOf("hosted", STREAMS_OFF), opt(false));
  assert.deepEqual(H.hostedOptionRowsOf("lan", WITH_STREAMS), [], "放本机的项目没有");
  assert.deepEqual(H.hostedOptionRowsOf(null, WITH_STREAMS), []);
  assert.deepEqual(H.hostedOptionRowsOf(undefined, WITH_STREAMS), []);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", null), [], "没有 hosted 字段");
  assert.deepEqual(H.hostedOptionRowsOf("hosted", ON), [], "旧托管端不报 streams:不出现");
  assert.deepEqual(H.hostedOptionRowsOf("hosted", { render: { available: false, enabled: true, streams: true } }), [], "这台托管端没有渲染节点");
  assert.deepEqual(H.hostedOptionRowsOf("hosted", { agent: { available: true, enabled: true } }), [], "只有云端 Agent 没有渲染节点");
});

test("HS10 置灰条件:渲染节点那一行关着时这一行仍出现但 parentOff 为真;它自己的勾选状态照旧", () => {
  assert.deepEqual(H.hostedOptionRowsOf("hosted", RENDER_OFF).map((r) => [r.enabled, r.parentOff]), [[true, true]]);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", { render: { available: true, enabled: false, streams: false } }).map((r) => [r.enabled, r.parentOff]), [[false, true]]);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", WITH_STREAMS).map((r) => r.parentOff), [false]);
});

test("HS10 通知落到状态上:认得的才改;旧托管端(没报 streams)、不认识的服务或选项、非布尔值都原样;不动别的字段", () => {
  assert.deepEqual(H.applyHostedOptionChange(WITH_STREAMS, "render", "streams", false), { ...WITH_STREAMS, render: { available: true, enabled: true, streams: false } });
  assert.deepEqual(H.applyHostedOptionChange(RENDER_OFF, "render", "streams", false).render, { available: true, enabled: false, streams: false }, "不动 enabled");
  assert.equal(H.applyHostedOptionChange(ON, "render", "streams", false), ON, "没报 streams 的托管端:不凭空造出来");
  assert.equal(H.applyHostedOptionChange(WITH_STREAMS, "render", "other", false), WITH_STREAMS);
  assert.equal(H.applyHostedOptionChange(WITH_STREAMS, "agent", "streams", false), WITH_STREAMS);
  assert.equal(H.applyHostedOptionChange(WITH_STREAMS, "render", "streams", "no"), WITH_STREAMS);
  assert.equal(H.applyHostedOptionChange(null, "render", "streams", false), null);
  // 服务开关的通知不冲掉 streams
  assert.deepEqual(H.applyHostedChange(WITH_STREAMS, "render", false).render, { available: true, enabled: false, streams: true });
});

test("HS10 文案(先照任务书,用户看过截图再定):标签、两个方向的说明、确认弹窗、别的成员的提示只在关闭时", () => {
  const t = H.hostedOptionText("render", "streams");
  assert.equal(t.label, "生成轨道流");
  assert.equal(t.hint(true), "托管方的渲染节点为这个项目生成轨道流，重卡在在线浏览器里播放更流畅。");
  assert.equal(t.hint(false), "没有打开：托管方的渲染节点不为这个项目生成轨道流，播放时用成员们各自设备生成的轨道流。打开后托管方也会生成，重卡在在线浏览器里播放更流畅，会多用云端的渲染时间。");
  assert.equal(t.confirm(true), "打开后，托管方的渲染节点会为这个项目生成轨道流。");
  assert.equal(t.confirm(false), "关闭后，托管方的渲染节点不再为这个项目生成轨道流，已经生成的保留。");
  assert.equal(t.changed(true), "", "打开时不提示,和另两行同一个规矩");
  assert.equal(t.changed(false), "创建者关闭了轨道流，托管方的渲染节点不再为这个项目生成轨道流。");
  assert.equal(H.hostedOptionText("render", "nope"), null);
  assert.equal(H.hostedOptionText("agent", "streams"), null);
  assert.equal(H.hostedOptionText(undefined, undefined), null);
});

const streamsBoxOf = (html) => html.match(/<input[^>]*data-pc="collab-hosted-render-streams-toggle"[^>]*>/)?.[0] ?? null;

test("HS11 组件:渲染节点那一行下面缩进多一行,按报来的值勾选;创建者能改,成员只读并带「只有创建者能改」", () => withRows(({ render }) => {
  const asCreator = render({ where: "hosted", hosted: WITH_STREAMS, creator: true, onToggleOption: () => {} });
  assert.match(asCreator, /生成轨道流/);
  assert.match(asCreator, /重卡在在线浏览器里播放更流畅/, "有一行说明");
  const box = streamsBoxOf(asCreator);
  assert.ok(box, "有勾选框");
  assert.match(box, /checked=""/, "报来是开就勾上");
  assert.doesNotMatch(box, /disabled/, "创建者可以改");
  assert.doesNotMatch(asCreator, /只有创建者能改/);
  assert.ok(asCreator.indexOf("托管方的渲染节点</label>") < asCreator.indexOf("生成轨道流"), "在渲染节点那一行后面");
  // 缩进:挂在渲染节点那一行的容器里,带缩进用的类
  assert.match(asCreator, /<div class="pc-collab-hosted-sub" data-pc="collab-hosted-render-streams" data-state="on">/);

  const asMember = render({ where: "hosted", hosted: WITH_STREAMS, creator: false, onToggleOption: () => {} });
  assert.match(streamsBoxOf(asMember), /checked=""/);
  assert.match(streamsBoxOf(asMember), /disabled=""/, "成员只读");
  assert.equal((asMember.match(/只有创建者能改/g) ?? []).length, 2, "渲染节点那一行、轨道流这一行各一条");

  const off = render({ where: "hosted", hosted: STREAMS_OFF, creator: true, onToggleOption: () => {} });
  assert.doesNotMatch(streamsBoxOf(off), /checked/, "关掉后不勾");
  assert.match(off, /没有打开：托管方的渲染节点不为这个项目生成轨道流，播放时用成员们各自设备生成的轨道流/);
  assert.match(off, /会多用云端的渲染时间/, "关着的说明讲清代价");
  assert.doesNotMatch(off, /渲染节点关着，暂不生效/, "渲染节点开着时不加这一句");
  assert.match(off, /data-state="off"/);

  const busy = render({ where: "hosted", hosted: WITH_STREAMS, creator: true, busy: true, onToggleOption: () => {} });
  assert.match(streamsBoxOf(busy), /disabled=""/, "忙的时候不能再点");
  const noHandler = render({ where: "hosted", hosted: WITH_STREAMS, creator: true });
  assert.match(streamsBoxOf(noHandler), /disabled=""/, "上层没接动作就当不能改");
}));

test("HS11 权限组:streamsAllowed 为 false 时,创建者也不能勾选,说明显示「你的账号没有开启这一项的权限，请联系托管方。」", () => withRows(({ render }) => {
  const notAllowedHosted = { render: { available: true, enabled: true, streams: false, streamsAllowed: false } };
  const html = render({ where: "hosted", hosted: notAllowedHosted, creator: true, onToggleOption: () => {} });
  assert.match(streamsBoxOf(html), /disabled=""/, "无权限时创建者也无法勾选");
  assert.match(html, /你的账号没有开启这一项的权限，请联系托管方。/);
  assert.match(html, /<div class="pc-collab-hosted-sub pc-collab-hosted-sub--off" data-pc="collab-hosted-render-streams" data-state="disabled">/);
}));

test("HS11 渲染节点那一行关着时:轨道流这一行置灰(不可点,带置灰类),勾选状态照旧;重新打开后恢复", () => withRows(({ render }) => {
  const html = render({ where: "hosted", hosted: RENDER_OFF, creator: true, onToggleOption: () => {} });
  assert.match(streamsBoxOf(html), /disabled=""/, "创建者也点不了");
  assert.match(streamsBoxOf(html), /checked=""/, "它自己的状态不变");
  assert.match(html, /重卡在在线浏览器里播放更流畅。（渲染节点关着，暂不生效）/, "开着的说明后面加一句");
  const offAndGrey = render({ where: "hosted", hosted: { render: { available: true, enabled: false, streams: false } }, creator: false, onToggleOption: () => {} });
  assert.match(offAndGrey, /会多用云端的渲染时间。（渲染节点关着，暂不生效）（只有创建者能改）/, "关着的说明后面加一句,成员再加「只有创建者能改」");
  assert.match(html, /<div class="pc-collab-hosted-sub pc-collab-hosted-sub--off" data-pc="collab-hosted-render-streams" data-state="disabled">/);
  const back = render({ where: "hosted", hosted: { render: { available: true, enabled: true, streams: true } }, creator: true, onToggleOption: () => {} });
  assert.doesNotMatch(streamsBoxOf(back), /disabled/);
  assert.doesNotMatch(back, /pc-collab-hosted-sub--off/);
}));

test("HS11 没有这一行的情况:放本机、没有 hosted、渲染节点不可用、旧托管端没报 streams(渲染节点那一行照常)", () => withRows(({ render }) => {
  assert.equal(render({ where: "lan", hosted: WITH_STREAMS, creator: true }), "");
  assert.equal(render({ where: "hosted", hosted: null, creator: true }), "");
  assert.equal(render({ where: "hosted", hosted: { render: { available: false, enabled: true, streams: true } }, creator: true }), "");
  const old = render({ where: "hosted", hosted: ON, creator: true, onToggleOption: () => {} });
  assert.equal(streamsBoxOf(old), null, "旧托管端:不显示轨道流");
  assert.doesNotMatch(old, /生成轨道流/);
  assert.match(checkboxOf(old), /checked=""/, "渲染节点那一行不受影响");
  assert.match(old, /托管方的渲染节点/);
}));

test("HS11 点勾选:把「哪个服务的哪个选项、要改成什么」交给上层(创建者身份验证与确认弹窗由上层做);渲染节点自己的勾选不受影响", () => withRows(({ M }) => {
  const calls = [];
  const services = [];
  const tree = M.HostedServiceRows({ where: "hosted", hosted: WITH_STREAMS, creator: true, onToggle: (...a) => services.push(a), onToggleOption: (...a) => calls.push(a) });
  const inputs = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "input") inputs.push(node);
    for (const k of React.Children.toArray(node.props?.children)) walk(k);
  };
  walk(tree);
  const byPc = (pc) => inputs.find((i) => i.props["data-pc"] === pc);
  const streams = byPc("collab-hosted-render-streams-toggle");
  assert.ok(streams, "找得到轨道流的勾选框");
  streams.props.onChange({ target: { checked: false } });
  streams.props.onChange({ target: { checked: true } });
  assert.deepEqual(calls, [["render", "streams", false], ["render", "streams", true]]);
  assert.deepEqual(services, [], "没有碰服务那一行的回调");
  byPc("collab-hosted-render-toggle").props.onChange({ target: { checked: false } });
  assert.deepEqual(services, [["render", false]]);
  assert.equal(calls.length, 2);
}));

test("HS12 向后兼容(页面一侧):旧托管端的成员列表(没有 streams)解析不变、别的行照旧;有 streams 的列表里服务那几行的状态不受影响", () => withRows(({ render }) => {
  // 新页面连旧文档服务:render/agent 都没有 streams
  const oldHosted = { render: { available: true, enabled: true }, agent: { available: true, enabled: true } };
  assert.deepEqual(H.parseHosted(oldHosted), oldHosted);
  assert.deepEqual(H.hostedRowsOf("hosted", oldHosted).map((r) => r.service), ["render", "agent"]);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", oldHosted), []);
  const html = render({ where: "hosted", hosted: oldHosted, creator: true });
  assert.match(html, /托管方的渲染节点/);
  assert.match(html, /云端 Agent/);
  assert.doesNotMatch(html, /轨道流/);
  // 新托管端多出的 streams 字段:服务那几行的 enabled 与 available 不受影响(旧页面只读这两项,多出的字段它不看)
  const rows = H.hostedRowsOf("hosted", { render: { available: true, enabled: false, streams: false }, agent: { available: true, enabled: true } });
  assert.deepEqual(rows.map((r) => [r.service, r.enabled]), [["render", false], ["agent", true]]);
}));

/* ---------------- 账号项目那条路(任务书 `docs/plan/render-refactor-task.md`「甲三」):状态从会话里来,没有创建者密码这一步 ---------------- */

test("HS13 账号项目:会话里的 hosted(渲染节点带 streams、云端 Agent 带 url)照样出这几行;创建者能改,成员只读;旧文档服务不报渲染节点就没有那两行", () => withRows(({ render }) => {
  // 新文档服务的会话:`hosted.render` 是 `{ available, enabled, streams }`,`hosted.agent` 多一个 url(界面不看)
  const session = { agent: { available: true, enabled: false, url: "https://example.invalid/agent/v1" }, render: { available: true, enabled: true, streams: false } };
  assert.deepEqual(H.hostedRowsOf("hosted", session).map((r) => [r.service, r.enabled]), [["render", true], ["agent", false]]);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", session), [{ service: "render", option: "streams", label: "生成轨道流", enabled: false, parentOff: false }]);
  const asCreator = render({ where: "hosted", hosted: session, creator: true, onToggleOption: () => {} });
  const box = (html, pc) => html.match(new RegExp(`<input[^>]*data-pc="${pc}"[^>]*>`))?.[0] ?? null;
  assert.doesNotMatch(box(asCreator, "collab-hosted-render-toggle"), /disabled/, "创建者能改渲染节点的开关");
  assert.doesNotMatch(box(asCreator, "collab-hosted-render-streams-toggle"), /disabled/, "创建者能改「生成轨道流」");
  const asMember = render({ where: "hosted", hosted: session, creator: false, onToggleOption: () => {} });
  assert.match(box(asMember, "collab-hosted-render-toggle"), /disabled=""/, "成员只读");
  assert.match(box(asMember, "collab-hosted-render-streams-toggle"), /disabled=""/, "成员只读");
  assert.match(asMember, /只有创建者能改/);
  // 账号项目新建时渲染节点是关的:轨道流那一行置灰
  const fresh = { agent: session.agent, render: { available: true, enabled: false, streams: false } };
  assert.equal(H.hostedOptionRowsOf("hosted", fresh)[0].parentOff, true);
  assert.match(box(render({ where: "hosted", hosted: fresh, creator: true, onToggleOption: () => {} }), "collab-hosted-render-streams-toggle"), /disabled=""/);
  // 旧文档服务的会话只有云端 Agent:没有渲染节点那两行,云端 Agent 一行照旧
  const old = { agent: session.agent };
  assert.deepEqual(H.hostedRowsOf("hosted", old).map((r) => r.service), ["agent"]);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", old), []);
  // 登记表里没有渲染服务(available 为假):同样没有那两行
  assert.deepEqual(H.hostedOptionRowsOf("hosted", { agent: session.agent, render: { available: false, enabled: false, streams: false } }), []);
}));

test("HS13 账号项目:成员靠前后两次读到的状态知道创建者改了什么 —— 只在关闭时提示(同口令项目的规矩与文案),打开、没变、头一次读到都不提示", () => {
  const view = (enabled, streams) => ({ render: { available: true, enabled, ...(streams === undefined ? {} : { streams }) }, agent: { available: true, enabled: true } });
  assert.deepEqual(H.hostedChangeNotices(view(true, true), view(true, false)), [H.HOSTED_OPTION_TEXT["render.streams"].changed(false)]);
  assert.deepEqual(H.hostedChangeNotices(view(true, true), view(false, true)), [H.HOSTED_SERVICE_TEXT.render.changed(false)]);
  assert.deepEqual(H.hostedChangeNotices(view(true, true), view(false, false)), [H.HOSTED_SERVICE_TEXT.render.changed(false), H.HOSTED_OPTION_TEXT["render.streams"].changed(false)]);
  assert.deepEqual(H.hostedChangeNotices(view(true, false), view(true, true)), [], "打开不提示");
  assert.deepEqual(H.hostedChangeNotices(view(false, false), view(true, false)), [], "打开不提示");
  assert.deepEqual(H.hostedChangeNotices(view(true, false), view(true, false)), [], "没变不提示");
  assert.deepEqual(H.hostedChangeNotices(null, view(true, false)), [], "头一次读到不提示");
  assert.deepEqual(H.hostedChangeNotices(view(true, true), null), []);
  assert.deepEqual(H.hostedChangeNotices(view(true), view(true, false)), [], "前一次没有这一项(旧文档服务刚升级)不提示");
  assert.deepEqual(H.hostedChangeNotices({ agent: { available: true, enabled: true } }, { agent: { available: true, enabled: false } }), [], "云端 Agent 不归这里");
});

test("HS13 改托管方服务的勾选:口令项目先验证创建者密码,账号项目没有这一步(凭登录态,服务端按创建者身份把关)", () => {
  assert.equal(H.hostedFlowNeedsPassword(false), true);
  assert.equal(H.hostedFlowNeedsPassword(true), false);
});

test("HS14 本页看到「生成轨道流」在起作用(在线页面据此在它从关变开时重发清单计划):放云端、有渲染节点、渲染节点开着、这一项开着四样都要;旧文档服务不报这一项就是 false", () => {
  const view = (render) => ({ render, agent: { available: true, enabled: true } });
  assert.equal(H.hostedStreamsOn("hosted", view({ available: true, enabled: true, streams: true })), true);
  assert.equal(H.hostedStreamsOn("hosted", view({ available: true, enabled: true, streams: false })), false);
  assert.equal(H.hostedStreamsOn("hosted", view({ available: true, enabled: false, streams: true })), false, "渲染节点关着:这一项开着也不起作用");
  assert.equal(H.hostedStreamsOn("hosted", view({ available: false, enabled: true, streams: true })), false, "这台托管端没有渲染节点");
  assert.equal(H.hostedStreamsOn("hosted", view({ available: true, enabled: true })), false, "新页面连旧文档服务(不报 streams):退回下一次改动起生效");
  assert.equal(H.hostedStreamsOn("lan", view({ available: true, enabled: true, streams: true })), false, "放本机的项目没有托管方的渲染节点");
  assert.equal(H.hostedStreamsOn("hosted", null), false);
  assert.equal(H.hostedStreamsOn(null, null), false);
  // 账号项目的会话形状同样读得出
  assert.equal(H.hostedStreamsOn("hosted", { agent: { available: true, enabled: false, url: null }, render: { available: true, enabled: true, streams: true } }), true);
});

test("STF2 账号项目:会话里 streamsAllowed 为 false(创建者不在权限分组)时「生成轨道流」置灰并提示;为 true 时能点", () => withRows(({ render }) => {
  const denied = { agent: { available: true, enabled: true, url: null }, render: { available: true, enabled: true, streams: false, streamsAllowed: false } };
  assert.equal(H.hostedOptionRowsOf("hosted", denied)[0].notAllowed, true);
  const html = render({ where: "hosted", hosted: denied, creator: true, onToggleOption: () => {} });
  assert.match(streamsBoxOf(html), /disabled=""/, "创建者不在分组:点不了");
  assert.match(html, /你的账号没有开启这一项的权限，请联系托管方。/);
  assert.match(html, /data-pc="collab-hosted-render-streams" data-state="disabled"/);
  const allowed = { ...denied, render: { ...denied.render, streamsAllowed: true } };
  const ok = render({ where: "hosted", hosted: allowed, creator: true, onToggleOption: () => {} });
  assert.doesNotMatch(streamsBoxOf(ok), /disabled/, "在分组内:能打开");
  assert.doesNotMatch(ok, /没有开启这一项的权限/);
  const on = render({ where: "hosted", hosted: { ...allowed, render: { ...allowed.render, streams: true } }, creator: true, onToggleOption: () => {} });
  assert.match(streamsBoxOf(on), /checked=""/); assert.doesNotMatch(streamsBoxOf(on), /disabled/, "打开后也能再关掉");
}));

test("STF3 改开关失败一定有一句看得懂的原因:账号项目照服务端的原因说,不再说「密码错误。」;口令项目照旧", () => {
  const fallback = (e) => (e === "forbidden" ? "密码错误。" : "没做成，稍后再试。");
  const denied = Object.assign(new Error("你的账号没有开启这一项的权限，请联系托管方。"), { status: 403, code: "permission-denied" });
  const r = H.accountHostedFailure(denied);
  assert.deepEqual(r, { ok: false, error: "forbidden", message: "你的账号没有开启这一项的权限，请联系托管方。" });
  assert.equal(H.hostedFailText(r, "没有这个选项", fallback), "你的账号没有开启这一项的权限，请联系托管方。");
  // 连不上、服务端出错、不认识的异常:也都有一句话,不会是空的
  assert.equal(H.accountHostedFailure(Object.assign(new Error("连接云端失败，请检查网络后重试。"), { status: 0, code: "network" })).message, "连接云端失败，请检查网络后重试。");
  assert.equal(H.accountHostedFailure(Object.assign(new Error("云端服务暂时不可用，请稍后重试。"), { status: 503, code: "account-unavailable" })).error, "other");
  assert.equal(H.accountHostedFailure(new TypeError("boom")).message, "没做成，稍后再试。");
  assert.equal(H.accountHostedFailure(undefined).message, "没做成，稍后再试。");
  // 口令项目(没有 message):照旧
  assert.equal(H.hostedFailText({ error: "forbidden" }, "没有这个选项", fallback), "密码错误。");
  assert.equal(H.hostedFailText({ error: "bad-message" }, "没有这个选项", fallback), "没有这个选项");
});
