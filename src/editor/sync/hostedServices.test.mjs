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

test("HR24a parse hosted: accepted only if the shape is right; a missing field (local project, old hosted side) is null", () => {
  assert.equal(H.parseHosted(undefined), null);
  assert.equal(H.parseHosted(null), null);
  assert.equal(H.parseHosted([]), null);
  assert.equal(H.parseHosted({}), null);
  assert.equal(H.parseHosted({ render: { available: "yes", enabled: true } }), null, "available is not a boolean, so it is not accepted");
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: false }, junk: 1 }), { render: { available: true, enabled: false } });
  assert.deepEqual(H.parseHosted(ON), ON);
});

test("HR24a display condition: this row exists only for a project in the cloud with available set; checked by default (absent from the record counts as on)", () => {
  assert.deepEqual(H.hostedRowsOf("hosted", ON), [{ service: "render", label: "Host's render node", enabled: true }]);
  assert.deepEqual(H.hostedRowsOf("hosted", OFF), [{ service: "render", label: "Host's render node", enabled: false }]);
  assert.deepEqual(H.hostedRowsOf("lan", ON), [], "a local project has no such row");
  assert.deepEqual(H.hostedRowsOf(null, ON), []);
  assert.deepEqual(H.hostedRowsOf("hosted", null), [], "no hosted field (old hosted side) means no such row");
  assert.deepEqual(H.hostedRowsOf("hosted", { render: { available: false, enabled: true } }), [], "the registry has no such service");
  assert.deepEqual(H.hostedRowsOf("hosted", { agent: { available: true, enabled: true } }), [{ service: "agent", label: "Cloud Agent", enabled: true }], "Cloud Agent row: appears only if the hosted side has this service, checked by default");
  assert.deepEqual(H.hostedRowsOf("hosted", { render: { available: true, enabled: true }, agent: { available: true, enabled: false } }).map((r) => [r.service, r.enabled]), [["render", true], ["agent", false]], "both rows present, render node first");
  assert.deepEqual(H.hostedRowsOf("lan", { agent: { available: true, enabled: true } }), [], "a local project has no Cloud Agent row");
});

test("CAU-SW-01 the wording of the Cloud Agent row matches the rest of the group; Cloud Agent connections and attribution under member rows", () => {
  const t = H.HOSTED_SERVICE_TEXT.agent;
  assert.equal(t.label, "Cloud Agent");
  for (const on of [true, false]) for (const f of [t.hint, t.confirm]) assert.ok(f(on).length > 8);
  assert.ok(t.changed(false).length > 8);
  assert.equal(t.changed(true), "", "bubble shown to other members only when turned off, no notice when turned on [user decision 2026-10-07]");
  assert.equal(H.HOSTED_SERVICE_TEXT.render.changed(true), "", "the render node follows the same rule: bubble shown to other members only when turned off, no notice when turned on [user decision 2026-10-07]");
  assert.match(H.HOSTED_SERVICE_TEXT.render.changed(false), /The creator turned off the host's render node/);
  assert.match(t.hint(false), /Turned off/);
  assert.match(t.changed(false), /The creator turned off the Cloud Agent/);
  assert.notEqual(H.HOSTED_SERVICE_TEXT.render.confirm(false), t.confirm(false), "the confirmation dialog text is written separately for each service");
  const conns = [{ role: "page" }, { role: "agent", conversation: 2 }, { role: "agent", conversation: "cc-1", service: "agent" }];
  assert.deepEqual(H.cloudAgentConns(conns), [{ role: "agent", conversation: "cc-1", service: "agent" }]);
  assert.equal(H.cloudAgentLabel("alice"), "alice's Cloud Agent");
});

test("HR24a notice applied to state: only a recognized service is changed; an unrecognized one, or a project without this service, is left as is", () => {
  assert.deepEqual(H.applyHostedChange(ON, "render", false), { ...ON, render: { available: true, enabled: false } });
  assert.equal(H.applyHostedChange(ON, "nope", false), ON);
  assert.equal(H.applyHostedChange(ON, "render", "no"), ON);
  assert.equal(H.applyHostedChange(null, "render", false), null);
  assert.equal(H.applyHostedChange({ agent: { available: true, enabled: true } }, "render", false).render, undefined, "if there is no render entry, don't create one out of thin air");
});

test("HR24a member list: service rows come after the members and are not counted in the member count; service names are independent of usernames", () => {
  const row = (username, extra = {}) => ({ username, displayName: username, deviceId: `${username}-d`, deviceName: null, creator: false, tags: { editing: false, rendering: false, agents: 0 }, conns: [], ...extra });
  const rows = [row("service:render", { service: "render", conns: [{ role: "render" }] }), row("bob"), row("alice", { creator: true })];
  const { people, services } = H.splitMembers(rows);
  assert.deepEqual(people.map((r) => r.username), ["bob", "alice"]);
  assert.deepEqual(services.map((r) => r.service), ["render"]);
  assert.equal(H.serviceRowLabel("render"), "Host's render node");
  assert.equal(H.serviceRowLabel("something-else"), "Host's service");
  assert.equal(H.serviceRowLabel(undefined), "Host's service");
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

test("HR24b cases with no such row: local project, no hosted field, available is false", () => withRows(({ render }) => {
  assert.equal(render({ where: "lan", hosted: ON, creator: true }), "");
  assert.equal(render({ where: "hosted", hosted: null, creator: true }), "");
  assert.equal(render({ where: "hosted", hosted: { render: { available: false, enabled: true } }, creator: true }), "");
}));

test("HR24b in the cloud and available: appears, checked by default; the creator can change it, members are read-only", () => withRows(({ render }) => {
  const asCreator = render({ where: "hosted", hosted: ON, creator: true });
  assert.match(asCreator, /Host&#x27;s render node/);
  const box = checkboxOf(asCreator);
  assert.ok(box, "has a checkbox");
  assert.match(box, /checked=""/, "checked by default");
  assert.doesNotMatch(box, /disabled/, "the creator can change it");
  assert.doesNotMatch(asCreator, /only the creator can change this/);

  const asMember = render({ where: "hosted", hosted: ON, creator: false });
  const memberBox = checkboxOf(asMember);
  assert.match(memberBox, /checked=""/);
  assert.match(memberBox, /disabled=""/, "members are read-only");
  assert.match(asMember, /only the creator can change this/);

  const closed = render({ where: "hosted", hosted: OFF, creator: true });
  assert.doesNotMatch(checkboxOf(closed), /checked/, "unchecked once turned off");
  assert.match(closed, /Turned off/);

  const busy = render({ where: "hosted", hosted: ON, creator: true, busy: true });
  assert.match(checkboxOf(busy), /disabled=""/, "even the creator can't click again while busy");
}));

test("HR24b clicking the checkbox: pass the requested new value up to the parent component (creator identity verification is done by the parent's CreatorFlow)", () => withRows(({ M }) => {
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
  assert.ok(input, "the checkbox can be found");
  input.props.onChange({ target: { checked: false } });
  input.props.onChange({ target: { checked: true } });
  assert.deepEqual(calls, [["render", false], ["render", true]]);
}));

/* ---------------- 第四段:项目设置里「云端 Agent」一行、署名(契约 `docs/plan/cloud-agent-contract.md` 第 5、9.5 节) ---------------- */

const agentBoxOf = (html) => html.match(/<input[^>]*data-pc="collab-hosted-agent-toggle"[^>]*>/)?.[0] ?? null;

test("CAU-SW-02 the \"Cloud Agent\" row in project settings: appears only for a project in the cloud with hosted.agent.available, checked by default; the creator can change it, members are read-only", () => withRows(({ render }) => {
  const BOTH = { render: { available: true, enabled: true }, agent: { available: true, enabled: true } };
  assert.equal(agentBoxOf(render({ where: "hosted", hosted: ON, creator: true })), null, "this hosted side has no Cloud Agent (available is false): no such row");
  assert.equal(render({ where: "lan", hosted: BOTH, creator: true }), "", "a local project has none");
  const asCreator = render({ where: "hosted", hosted: BOTH, creator: true });
  assert.match(asCreator, /Cloud Agent/);
  assert.match(asCreator, /choose &quot;Cloud&quot; in the AI panel/, "has a line of explanation");
  assert.match(agentBoxOf(asCreator), /checked=""/, "checked by default");
  assert.doesNotMatch(agentBoxOf(asCreator), /disabled/, "the creator can change it");
  assert.ok(asCreator.indexOf("Host&#x27;s render node") < asCreator.indexOf("Cloud Agent"), "placed together with the render node's switch, after it");
  const asMember = render({ where: "hosted", hosted: BOTH, creator: false });
  assert.match(agentBoxOf(asMember), /disabled=""/, "members are read-only");
  const closed = render({ where: "hosted", hosted: { ...BOTH, agent: { available: true, enabled: false } }, creator: false });
  assert.doesNotMatch(agentBoxOf(closed), /checked/);
  assert.match(closed, /Turned off: members can no longer use the Cloud Agent/);
}));

test("CAU-SIGN-01 attribution: others see a Cloud Agent's changes as \"<member name>'s Cloud Agent\", the originating device shows \"Your Cloud Agent\"; the wording for local Agents is unchanged", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const L = await server.ssrLoadModule("/src/editor/sync/labels.ts");
    const bob = { session: "s-bob", userId: "bob@dev-b" };
    const cloud = { userId: "alice@dev-a", deviceId: "dev-a", role: "agent", conversation: 3, session: "s-agent", service: "agent" };
    // 两种形状都认:DocSync 记的 { actor, session },与文档服务直接给的 actor 本身
    assert.equal(L.writerLabel({ actor: cloud, session: "s-agent" }, bob), "alice's Cloud Agent");
    assert.equal(L.writerLabel(cloud, bob), "alice's Cloud Agent");
    // 发起成员不在线(成员列表里查不到显示名)时照样有名字;在线、重名带设备名时也只用用户名
    assert.equal(L.writerLabel({ actor: cloud }, bob, new Map([["alice@dev-a", "alice (computer)"]])), "alice's Cloud Agent");
    // 用户名里带 @ 的:取最后一个 @ 之前
    assert.equal(L.writerLabel({ actor: { ...cloud, userId: "a@b@dev-a" } }, bob), "a@b's Cloud Agent");
    // 发起的那台设备上
    assert.equal(L.writerLabel({ actor: cloud }, { session: "s-alice", userId: "alice@dev-a" }), "Your Cloud Agent");
    // 同一位成员在另一台设备上看:按名字说
    assert.equal(L.writerLabel({ actor: cloud }, { session: "s-alice-2", userId: "alice@dev-a2" }), "alice's Cloud Agent");
    // 本机 Agent 的说法不变
    const local = { userId: "alice@dev-a", deviceId: "dev-a", role: "agent", conversation: 2, session: "s-x" };
    assert.equal(L.writerLabel({ actor: { ...local, username: "alice" } }, bob, new Map([["alice@dev-a", "alice"]])), "alice · Agent · Chat #2");
    assert.equal(L.writerLabel({ actor: local }, bob), "Agent\"Chat #2\"");
    assert.equal(L.writerLabel({ actor: local }, { session: "s-alice", userId: "alice@dev-a" }), "Agent\"Chat #2\"");
    assert.equal(L.writerLabel({ actor: { userId: "alice@dev-a", role: "page", session: "s-p" } }, bob, new Map([["alice@dev-a", "alice"]])), "alice");
  } finally {
    await server.close();
  }
});

const mrow = (username, conns, extra = {}) => ({ username, displayName: username, deviceId: `${username}-d`, deviceName: null, creator: false, tags: { editing: conns.some((c) => c.role === "page"), rendering: false, agents: conns.filter((c) => c.role === "agent").length }, conns, ...extra });

/** 「有一轮在跑」表:成员键是 用户名@设备号(与成员行的 `${username}@${deviceId}` 同一写法,mrow 的设备号是 `<用户名>-d`) */
const running = (...names) => new Set(names.map((n) => `${n}@${n}-d`));
const NONE = new Set();

test("CAU-MEM-01 member counting rule [user decision 2026-10-07, changed the same day to count by \"round running\"]: the member count only counts people who are online; Agent count = local + Cloud Agents with a round running; a member who is offline with only idle cloud connections left is not shown", () => {
  const alice = mrow("alice", [{ role: "page" }, { role: "agent", conversation: 1 }, { role: "agent", conversation: 2 }]);
  const bob = mrow("bob", [{ role: "page" }, { role: "agent", conversation: "cc-1", service: "agent" }, { role: "agent", conversation: "cc-1", service: "agent" }]);
  const carol = mrow("carol", [{ role: "agent", conversation: "cc-2", service: "agent" }]);
  const render = mrow("service:render", [{ role: "render" }], { service: "render" });
  const { people } = H.splitMembers([alice, bob, carol, render]);
  assert.equal(people.length, 3, "the render node row does not count as a member");
  // 谁都没有一轮在跑:bob 的云端 Agent 闲置(不计),carol 本人不在线、只剩闲置连接(整行不显示、不计)
  assert.deepEqual(H.memberCounts(people, NONE), { people: 2, agents: 2 }, "only alice's 2 local Agents remain; the cloud connections of bob and carol are both idle, not counted");
  assert.deepEqual(H.visibleMembers(people, NONE).map((r) => r.username), ["alice", "bob"], "carol is not online in person and only an idle Cloud Agent connection remains: this row is not shown");
  assert.equal(H.memberCountLabel(people, NONE), "Members: 2 · Agents: 2");
  assert.equal(H.isCloudAgentOnly(carol, NONE), false, "an idle one is not labeled \"Offline, Agent running\"");
  assert.equal(H.isIdleCloudAgentOnly(carol, NONE), true);
  assert.equal(H.isCloudAgentRunning(bob, NONE), false, "the member is online and the Cloud Agent is idle: the \"[Cloud Agent]\" tag is not shown");
  // bob、carol 各有一轮在跑:bob 云端算 1 个(多条连接只算一个),carol 的行回来、标「离线,Agent 在跑」、计入 Agent 数、不计入人数
  const both = running("bob", "carol");
  assert.deepEqual(H.memberCounts(people, both), { people: 2, agents: 4 }, "alice and bob are online in person; Agents: alice's 2 local + bob's 1 cloud + carol's 1 cloud");
  assert.equal(H.memberCountLabel(people, both), "Members: 2 · Agents: 4");
  assert.deepEqual(H.visibleMembers(people, both).map((r) => r.username), ["alice", "bob", "carol"]);
  assert.equal(H.isPersonOnline(alice), true);
  assert.equal(H.isPersonOnline(carol), false);
  assert.equal(H.isCloudAgentOnly(carol, both), true, "the member is not online in person and the Cloud Agent has a round running: labeled \"Offline, Agent running\"");
  assert.equal(H.isCloudAgentOnly(bob, both), false, "a member who is online in person is not labeled");
  assert.equal(H.isCloudAgentRunning(bob, both), true, "the member is online and a round is running: the \"[Cloud Agent]\" tag is shown");
  assert.equal(H.isCloudAgentOnly(alice, both), false);
  assert.equal(H.isCloudAgentOnly(mrow("dave", []), running("dave")), false, "no connection at all does not count");
  // 表里有这位成员、但他名下并没有云端 Agent 的连接(成员列表还没跟上):不算
  assert.equal(H.isCloudAgentRunning(alice, running("alice")), false, "no Cloud Agent connection: not counted even if it is in the table");
  assert.equal(H.memberKeyOf(alice), "alice@alice-d", "the member key is username@device id");
});

test("CAU-MEM-02 member count: with only yourself online it reads \"Members: 1 · Agents: 0\"; your own local Agents and your own Cloud Agent with a round running both count as Agents; your own row also follows this table", () => {
  assert.equal(H.memberCountLabel([], NONE), "Members: 1 · Agents: 0", "you are always online, so the member count is at least 1");
  const me = mrow("me", [{ role: "page" }]);
  assert.equal(H.memberCountLabel([me], NONE), "Members: 1 · Agents: 0");
  const me2 = mrow("me", [{ role: "page" }, { role: "agent", conversation: 1 }, { role: "agent", conversation: "cc-9", service: "agent" }]);
  assert.equal(H.memberCountLabel([me2], NONE), "Members: 1 · Agents: 1", "your own Cloud Agent is idle: only the 1 local Agent counts");
  assert.equal(H.memberCountLabel([me2], running("me")), "Members: 1 · Agents: 2", "your own Cloud Agent has a round running: 1 local + 1 cloud");
  assert.equal(H.isCloudAgentRunning(me2, running("me")), true, "your own row also shows \"[Cloud Agent]\" according to this table");
  assert.equal(H.isCloudAgentRunning(me2, NONE), false);
  // 只有自己的云端 Agent 连着(自己的页面都关了):闲置时整行不显示、不计;一轮在跑时标「离线,Agent 在跑」、计 Agent、不计人数
  const gone = mrow("gone", [{ role: "agent", conversation: "cc-3", service: "agent" }]);
  assert.equal(H.memberCountLabel([me, gone], NONE), "Members: 1 · Agents: 0");
  assert.equal(H.memberCountLabel([me, gone], running("gone")), "Members: 1 · Agents: 1");
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

test("HS10 parse hosted: streams is accepted only if it is a boolean; a non-boolean is dropped but the service is still accepted; streams on the Cloud Agent is not accepted; streamsAllowed is accepted as is", () => {
  assert.deepEqual(H.parseHosted(WITH_STREAMS), WITH_STREAMS);
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: true, streams: false } }), STREAMS_OFF);
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: true, streams: false, streamsAllowed: false } }), { render: { available: true, enabled: true, streams: false, streamsAllowed: false } });
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: true, streams: "yes" } }), { render: { available: true, enabled: true } }, "streams is not a boolean: drop only that entry");
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: true, streams: null } }), { render: { available: true, enabled: true } });
  assert.deepEqual(H.parseHosted({ agent: { available: true, enabled: true, streams: true } }), { agent: { available: true, enabled: true } }, "only the render node has this entry");
});

test("HS10 display condition: in the cloud, render.available, and the document service reported streams (not shown if the old hosted side doesn't report it); off by default (absent from the record counts as off; the document service works it out before reporting, and the page only displays the reported value)", () => {
  const opt = (enabled, parentOff = false) => [{ service: "render", option: "streams", label: "Generate track streams", enabled, parentOff }];
  assert.deepEqual(H.hostedOptionRowsOf("hosted", WITH_STREAMS), opt(true));
  assert.deepEqual(H.hostedOptionRowsOf("hosted", STREAMS_OFF), opt(false));
  assert.deepEqual(H.hostedOptionRowsOf("lan", WITH_STREAMS), [], "a local project has none");
  assert.deepEqual(H.hostedOptionRowsOf(null, WITH_STREAMS), []);
  assert.deepEqual(H.hostedOptionRowsOf(undefined, WITH_STREAMS), []);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", null), [], "no hosted field");
  assert.deepEqual(H.hostedOptionRowsOf("hosted", ON), [], "old hosted side does not report streams: not shown");
  assert.deepEqual(H.hostedOptionRowsOf("hosted", { render: { available: false, enabled: true, streams: true } }), [], "this hosted side has no render node");
  assert.deepEqual(H.hostedOptionRowsOf("hosted", { agent: { available: true, enabled: true } }), [], "only a Cloud Agent and no render node");
});

test("HS10 greyed-out condition: when the render node row is off, this row still appears but parentOff is true; its own checked state stays as is", () => {
  assert.deepEqual(H.hostedOptionRowsOf("hosted", RENDER_OFF).map((r) => [r.enabled, r.parentOff]), [[true, true]]);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", { render: { available: true, enabled: false, streams: false } }).map((r) => [r.enabled, r.parentOff]), [[false, true]]);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", WITH_STREAMS).map((r) => r.parentOff), [false]);
});

test("HS10 notice applied to state: only recognized ones are changed; an old hosted side (no streams reported), an unrecognized service or option, and non-boolean values are all left as is; other fields are untouched", () => {
  assert.deepEqual(H.applyHostedOptionChange(WITH_STREAMS, "render", "streams", false), { ...WITH_STREAMS, render: { available: true, enabled: true, streams: false } });
  assert.deepEqual(H.applyHostedOptionChange(RENDER_OFF, "render", "streams", false).render, { available: true, enabled: false, streams: false }, "enabled is untouched");
  assert.equal(H.applyHostedOptionChange(ON, "render", "streams", false), ON, "a hosted side that doesn't report streams: don't create one out of thin air");
  assert.equal(H.applyHostedOptionChange(WITH_STREAMS, "render", "other", false), WITH_STREAMS);
  assert.equal(H.applyHostedOptionChange(WITH_STREAMS, "agent", "streams", false), WITH_STREAMS);
  assert.equal(H.applyHostedOptionChange(WITH_STREAMS, "render", "streams", "no"), WITH_STREAMS);
  assert.equal(H.applyHostedOptionChange(null, "render", "streams", false), null);
  // 服务开关的通知不冲掉 streams
  assert.deepEqual(H.applyHostedChange(WITH_STREAMS, "render", false).render, { available: true, enabled: false, streams: true });
});

test("HS10 wording (follows the task brief for now, to be settled after the user has seen screenshots): the label, the explanations for both directions, the confirmation dialog, and the notice to other members only when turned off", () => {
  const t = H.hostedOptionText("render", "streams");
  assert.equal(t.label, "Generate track streams");
  assert.equal(t.hint(true), "The host's render node generates track streams for this project, so heavy cards play more smoothly in the online browser.");
  assert.equal(t.hint(false), "Not turned on: the host's render node does not generate track streams for this project, and playback uses the track streams generated on each member's own device. Once turned on, the host generates them too, so heavy cards play more smoothly in the online browser, at the cost of more cloud render time.");
  assert.equal(t.confirm(true), "Once turned on, the host's render node will generate track streams for this project.");
  assert.equal(t.confirm(false), "Once turned off, the host's render node no longer generates track streams for this project, and the ones already generated are kept.");
  assert.equal(t.changed(true), "", "no notice when turned on, the same rule as the other two rows");
  assert.equal(t.changed(false), "The creator turned off track streams, so the host's render node no longer generates track streams for this project.");
  assert.equal(H.hostedOptionText("render", "nope"), null);
  assert.equal(H.hostedOptionText("agent", "streams"), null);
  assert.equal(H.hostedOptionText(undefined, undefined), null);
});

const streamsBoxOf = (html) => html.match(/<input[^>]*data-pc="collab-hosted-render-streams-toggle"[^>]*>/)?.[0] ?? null;

test("HS11 component: one more indented row under the render node row, checked according to the reported value; the creator can change it, members are read-only and get \"Only the creator can change this\"", () => withRows(({ render }) => {
  const asCreator = render({ where: "hosted", hosted: WITH_STREAMS, creator: true, onToggleOption: () => {} });
  assert.match(asCreator, /Generate track streams/);
  assert.match(asCreator, /heavy cards play more smoothly in the online browser/, "has a line of explanation");
  const box = streamsBoxOf(asCreator);
  assert.ok(box, "has a checkbox");
  assert.match(box, /checked=""/, "checked if the reported value is on");
  assert.doesNotMatch(box, /disabled/, "the creator can change it");
  assert.doesNotMatch(asCreator, /only the creator can change this/);
  assert.ok(asCreator.indexOf("Host&#x27;s render node</label>") < asCreator.indexOf("Generate track streams"), "after the render node row");
  // 缩进:挂在渲染节点那一行的容器里,带缩进用的类
  assert.match(asCreator, /<div class="pc-collab-hosted-sub" data-pc="collab-hosted-render-streams" data-state="on">/);

  const asMember = render({ where: "hosted", hosted: WITH_STREAMS, creator: false, onToggleOption: () => {} });
  assert.match(streamsBoxOf(asMember), /checked=""/);
  assert.match(streamsBoxOf(asMember), /disabled=""/, "members are read-only");
  assert.equal((asMember.match(/only the creator can change this/g) ?? []).length, 2, "one for the render node row and one for the track streams row");

  const off = render({ where: "hosted", hosted: STREAMS_OFF, creator: true, onToggleOption: () => {} });
  assert.doesNotMatch(streamsBoxOf(off), /checked/, "unchecked once turned off");
  assert.match(off, /Not turned on: the host&#x27;s render node does not generate track streams for this project, and playback uses the track streams generated on each member&#x27;s own device/);
  assert.match(off, /at the cost of more cloud render time/, "the off explanation spells out the cost");
  assert.doesNotMatch(off, /render node is off, not in effect for now/, "this sentence is not added when the render node is on");
  assert.match(off, /data-state="off"/);

  const busy = render({ where: "hosted", hosted: WITH_STREAMS, creator: true, busy: true, onToggleOption: () => {} });
  assert.match(streamsBoxOf(busy), /disabled=""/, "can't be clicked again while busy");
  const noHandler = render({ where: "hosted", hosted: WITH_STREAMS, creator: true });
  assert.match(streamsBoxOf(noHandler), /disabled=""/, "if the parent component has not wired up the action, treat it as not changeable");
}));

test("HS11 permission group: when streamsAllowed is false, even the creator cannot check it, and the explanation reads \"Your account does not have permission to turn this on. Please contact the host.\"", () => withRows(({ render }) => {
  const notAllowedHosted = { render: { available: true, enabled: true, streams: false, streamsAllowed: false } };
  const html = render({ where: "hosted", hosted: notAllowedHosted, creator: true, onToggleOption: () => {} });
  assert.match(streamsBoxOf(html), /disabled=""/, "without permission even the creator cannot check it");
  assert.match(html, /Your account does not have permission to enable this option. Please contact the host./);
  assert.match(html, /<div class="pc-collab-hosted-sub pc-collab-hosted-sub--off" data-pc="collab-hosted-render-streams" data-state="disabled">/);
}));

test("HS11 when the render node row is off: the track streams row is greyed out (not clickable, carries the grey class), its checked state stays as is; restored once turned back on", () => withRows(({ render }) => {
  const html = render({ where: "hosted", hosted: RENDER_OFF, creator: true, onToggleOption: () => {} });
  assert.match(streamsBoxOf(html), /disabled=""/, "even the creator can't click it");
  assert.match(streamsBoxOf(html), /checked=""/, "its own state is unchanged");
  assert.match(html, /heavy cards play more smoothly in the online browser\.\(render node is off, not in effect for now\)/, "add one sentence after the on explanation");
  const offAndGrey = render({ where: "hosted", hosted: { render: { available: true, enabled: false, streams: false } }, creator: false, onToggleOption: () => {} });
  assert.match(offAndGrey, /at the cost of more cloud render time\.\(render node is off, not in effect for now\)\(only the creator can change this\)/, "add one sentence after the off explanation, and members get \"Only the creator can change this\" as well");
  assert.match(html, /<div class="pc-collab-hosted-sub pc-collab-hosted-sub--off" data-pc="collab-hosted-render-streams" data-state="disabled">/);
  const back = render({ where: "hosted", hosted: { render: { available: true, enabled: true, streams: true } }, creator: true, onToggleOption: () => {} });
  assert.doesNotMatch(streamsBoxOf(back), /disabled/);
  assert.doesNotMatch(back, /pc-collab-hosted-sub--off/);
}));

test("HS11 cases with no such row: local project, no hosted, render node unavailable, old hosted side did not report streams (the render node row is as usual)", () => withRows(({ render }) => {
  assert.equal(render({ where: "lan", hosted: WITH_STREAMS, creator: true }), "");
  assert.equal(render({ where: "hosted", hosted: null, creator: true }), "");
  assert.equal(render({ where: "hosted", hosted: { render: { available: false, enabled: true, streams: true } }, creator: true }), "");
  const old = render({ where: "hosted", hosted: ON, creator: true, onToggleOption: () => {} });
  assert.equal(streamsBoxOf(old), null, "old hosted side: track streams not shown");
  assert.doesNotMatch(old, /Generate track streams/);
  assert.match(checkboxOf(old), /checked=""/, "the render node row is unaffected");
  assert.match(old, /Host&#x27;s render node/);
}));

test("HS11 clicking the checkbox: pass \"which option of which service, and what to change it to\" up to the parent component (creator identity verification and the confirmation dialog are done by the parent); the render node's own checkbox is unaffected", () => withRows(({ M }) => {
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
  assert.ok(streams, "the track streams checkbox can be found");
  streams.props.onChange({ target: { checked: false } });
  streams.props.onChange({ target: { checked: true } });
  assert.deepEqual(calls, [["render", "streams", false], ["render", "streams", true]]);
  assert.deepEqual(services, [], "the callback for the service row was not touched");
  byPc("collab-hosted-render-toggle").props.onChange({ target: { checked: false } });
  assert.deepEqual(services, [["render", false]]);
  assert.equal(calls.length, 2);
}));

test("HS12 backward compatibility (page side): the member list from an old hosted side (without streams) parses unchanged and the other rows stay as before; in a list that has streams, the state of the service rows is unaffected", () => withRows(({ render }) => {
  // 新页面连旧文档服务:render/agent 都没有 streams
  const oldHosted = { render: { available: true, enabled: true }, agent: { available: true, enabled: true } };
  assert.deepEqual(H.parseHosted(oldHosted), oldHosted);
  assert.deepEqual(H.hostedRowsOf("hosted", oldHosted).map((r) => r.service), ["render", "agent"]);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", oldHosted), []);
  const html = render({ where: "hosted", hosted: oldHosted, creator: true });
  assert.match(html, /Host&#x27;s render node/);
  assert.match(html, /Cloud Agent/);
  assert.doesNotMatch(html, /track streams/);
  // 新托管端多出的 streams 字段:服务那几行的 enabled 与 available 不受影响(旧页面只读这两项,多出的字段它不看)
  const rows = H.hostedRowsOf("hosted", { render: { available: true, enabled: false, streams: false }, agent: { available: true, enabled: true } });
  assert.deepEqual(rows.map((r) => [r.service, r.enabled]), [["render", false], ["agent", true]]);
}));

/* ---------------- 账号项目那条路(任务书 `docs/plan/render-refactor-task.md`「甲三」):状态从会话里来,没有创建者密码这一步 ---------------- */

test("HS13 account project: the hosted object in the session (render node with streams, Cloud Agent with url) still produces these rows; the creator can change them, members are read-only; an old document service that doesn't report the render node has neither of those two rows", () => withRows(({ render }) => {
  // 新文档服务的会话:`hosted.render` 是 `{ available, enabled, streams }`,`hosted.agent` 多一个 url(界面不看)
  const session = { agent: { available: true, enabled: false, url: "https://example.invalid/agent/v1" }, render: { available: true, enabled: true, streams: false } };
  assert.deepEqual(H.hostedRowsOf("hosted", session).map((r) => [r.service, r.enabled]), [["render", true], ["agent", false]]);
  assert.deepEqual(H.hostedOptionRowsOf("hosted", session), [{ service: "render", option: "streams", label: "Generate track streams", enabled: false, parentOff: false }]);
  const asCreator = render({ where: "hosted", hosted: session, creator: true, onToggleOption: () => {} });
  const box = (html, pc) => html.match(new RegExp(`<input[^>]*data-pc="${pc}"[^>]*>`))?.[0] ?? null;
  assert.doesNotMatch(box(asCreator, "collab-hosted-render-toggle"), /disabled/, "the creator can change the render node switch");
  assert.doesNotMatch(box(asCreator, "collab-hosted-render-streams-toggle"), /disabled/, "the creator can change \"Generate track streams\"");
  const asMember = render({ where: "hosted", hosted: session, creator: false, onToggleOption: () => {} });
  assert.match(box(asMember, "collab-hosted-render-toggle"), /disabled=""/, "members are read-only");
  assert.match(box(asMember, "collab-hosted-render-streams-toggle"), /disabled=""/, "members are read-only");
  assert.match(asMember, /only the creator can change this/);
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

test("HS13 account project: members learn what the creator changed from the states read before and after; a notice appears only when turned off (same rule and wording as passphrase projects), and there is no notice for turning on, no change, or the first read", () => {
  const view = (enabled, streams) => ({ render: { available: true, enabled, ...(streams === undefined ? {} : { streams }) }, agent: { available: true, enabled: true } });
  assert.deepEqual(H.hostedChangeNotices(view(true, true), view(true, false)), [H.HOSTED_OPTION_TEXT["render.streams"].changed(false)]);
  assert.deepEqual(H.hostedChangeNotices(view(true, true), view(false, true)), [H.HOSTED_SERVICE_TEXT.render.changed(false)]);
  assert.deepEqual(H.hostedChangeNotices(view(true, true), view(false, false)), [H.HOSTED_SERVICE_TEXT.render.changed(false), H.HOSTED_OPTION_TEXT["render.streams"].changed(false)]);
  assert.deepEqual(H.hostedChangeNotices(view(true, false), view(true, true)), [], "no notice when turned on");
  assert.deepEqual(H.hostedChangeNotices(view(false, false), view(true, false)), [], "no notice when turned on");
  assert.deepEqual(H.hostedChangeNotices(view(true, false), view(true, false)), [], "no notice when unchanged");
  assert.deepEqual(H.hostedChangeNotices(null, view(true, false)), [], "no notice on the first read");
  assert.deepEqual(H.hostedChangeNotices(view(true, true), null), []);
  assert.deepEqual(H.hostedChangeNotices(view(true), view(true, false)), [], "no notice when the previous read had no such entry (old document service just upgraded)");
  assert.deepEqual(H.hostedChangeNotices({ agent: { available: true, enabled: true } }, { agent: { available: true, enabled: false } }), [], "the Cloud Agent is not handled here");
});

test("HS13 changing a host service checkbox: a passphrase project verifies the creator's password first; an account project has no such step (it relies on the login state, and the server enforces it by creator identity)", () => {
  assert.equal(H.hostedFlowNeedsPassword(false), true);
  assert.equal(H.hostedFlowNeedsPassword(true), false);
});

test("HS14 this page sees \"Generate track streams\" taking effect (the online page uses this to resend the manifest plan when it goes from off to on): in the cloud, has a render node, render node on, and this option on, all four are required; if an old document service doesn't report this option it is false", () => {
  const view = (render) => ({ render, agent: { available: true, enabled: true } });
  assert.equal(H.hostedStreamsOn("hosted", view({ available: true, enabled: true, streams: true })), true);
  assert.equal(H.hostedStreamsOn("hosted", view({ available: true, enabled: true, streams: false })), false);
  assert.equal(H.hostedStreamsOn("hosted", view({ available: true, enabled: false, streams: true })), false, "render node off: this option has no effect even when on");
  assert.equal(H.hostedStreamsOn("hosted", view({ available: false, enabled: true, streams: true })), false, "this hosted side has no render node");
  assert.equal(H.hostedStreamsOn("hosted", view({ available: true, enabled: true })), false, "new page connected to an old document service (no streams reported): falls back to taking effect from the next change");
  assert.equal(H.hostedStreamsOn("lan", view({ available: true, enabled: true, streams: true })), false, "a local project has no host render node");
  assert.equal(H.hostedStreamsOn("hosted", null), false);
  assert.equal(H.hostedStreamsOn(null, null), false);
  // 账号项目的会话形状同样读得出
  assert.equal(H.hostedStreamsOn("hosted", { agent: { available: true, enabled: false, url: null }, render: { available: true, enabled: true, streams: true } }), true);
});

test("STF2 account project: when streamsAllowed in the session is false (the creator is not in the permission group), \"Generate track streams\" is greyed out with a notice; when true, it can be clicked", () => withRows(({ render }) => {
  const denied = { agent: { available: true, enabled: true, url: null }, render: { available: true, enabled: true, streams: false, streamsAllowed: false } };
  assert.equal(H.hostedOptionRowsOf("hosted", denied)[0].notAllowed, true);
  const html = render({ where: "hosted", hosted: denied, creator: true, onToggleOption: () => {} });
  assert.match(streamsBoxOf(html), /disabled=""/, "the creator is not in the group: can't click it");
  assert.match(html, /Your account does not have permission to enable this option. Please contact the host./);
  assert.match(html, /data-pc="collab-hosted-render-streams" data-state="disabled"/);
  const allowed = { ...denied, render: { ...denied.render, streamsAllowed: true } };
  const ok = render({ where: "hosted", hosted: allowed, creator: true, onToggleOption: () => {} });
  assert.doesNotMatch(streamsBoxOf(ok), /disabled/, "in the group: can be turned on");
  assert.doesNotMatch(ok, /does not have permission to enable this option/);
  const on = render({ where: "hosted", hosted: { ...allowed, render: { ...allowed.render, streams: true } }, creator: true, onToggleOption: () => {} });
  assert.match(streamsBoxOf(on), /checked=""/); assert.doesNotMatch(streamsBoxOf(on), /disabled/, "can be turned off again after turning on");
}));

test("STF3 a failed switch change always gives an understandable reason: an account project states the server's reason and no longer says \"Incorrect password.\"; a passphrase project stays as before", () => {
  const fallback = (e) => (e === "forbidden" ? "Wrong password." : "Did not succeed, try again later.");
  const denied = Object.assign(new Error("Your account does not have permission to enable this option. Please contact the host."), { status: 403, code: "permission-denied" });
  const r = H.accountHostedFailure(denied);
  assert.deepEqual(r, { ok: false, error: "forbidden", message: "Your account does not have permission to enable this option. Please contact the host." });
  assert.equal(H.hostedFailText(r, "No such option", fallback), "Your account does not have permission to enable this option. Please contact the host.");
  // 连不上、服务端出错、不认识的异常:也都有一句话,不会是空的
  assert.equal(H.accountHostedFailure(Object.assign(new Error("Failed to connect to the cloud. Check the network and try again."), { status: 0, code: "network" })).message, "Failed to connect to the cloud. Check the network and try again.");
  assert.equal(H.accountHostedFailure(Object.assign(new Error("The cloud service is temporarily unavailable. Please try again later."), { status: 503, code: "account-unavailable" })).error, "other");
  assert.equal(H.accountHostedFailure(new TypeError("boom")).message, "Did not succeed, try again later.");
  assert.equal(H.accountHostedFailure(undefined).message, "Did not succeed, try again later.");
  // 口令项目(没有 message):照旧
  assert.equal(H.hostedFailText({ error: "forbidden" }, "No such option", fallback), "Wrong password.");
  assert.equal(H.hostedFailText({ error: "bad-message" }, "No such option", fallback), "No such option");
});
