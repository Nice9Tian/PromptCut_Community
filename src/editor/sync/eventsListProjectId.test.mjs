/**
 * 回归(探针 A7):页面向文档服务补取工具调用记录的 `events.list` 必须带项目号。
 * 文档服务(`server/docservice/modules/events.mjs` 的 `list`)不带项目号回 bad-message「projectId 不合法」;
 * 账号项目那条路曾有两处不带(进项目时、断线重连后),云端 Agent 跑完后重开的页面没有工具调用记录,也没有「撤销这步」。
 *
 * `syncManager.ts` 在 Node 里载不起来(要浏览器环境),这里逐处核对源码里每一条 `events.list` 消息都带 `projectId`,
 * 并用文档服务的事件模块确认不带项目号确实会被拒、带了能取到。
 *
 *   node --test src/editor/sync/eventsListProjectId.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

test("EVL-01 syncManager.ts 里每一条 events.list 消息都带 projectId", () => {
  const src = fs.readFileSync(path.join(here, "syncManager.ts"), "utf8");
  // 找出所有 `{ type: 'events.list' ... }` 对象字面量(到同一层的右花括号为止)
  const sends = [...src.matchAll(/\{\s*type:\s*["']events\.list["'][^}]*\}/g)].map((m) => m[0]);
  assert.ok(sends.length >= 4, `找到的 events.list 消息太少(${sends.length}),源码改了写法就更新这条测试`);
  for (const s of sends) assert.match(s, /projectId\s*:/, `这条 events.list 没带 projectId:${s}`);
});

test("EVL-02 文档服务的 events.list:不带 projectId 回 bad-message,带了回 events.listing", async () => {
  const { eventsModule } = await import(pathToFileURL(path.join(root, "server/docservice/modules/events.mjs")).href);
  const m = eventsModule({ project: { publishToProject: () => {} } });
  const sent = [];
  const ctx = { send: (connId, msg) => sent.push(msg), now: () => Date.now() };
  m.connect(ctx, "c1", { userId: "u", tenantId: "sp_" + "a".repeat(26) });
  m.handle(ctx, "c1", { type: "events.list" });
  m.handle(ctx, "c1", { type: "events.list", projectId: "sp_" + "a".repeat(26) });
  const [bad, ok] = sent;
  assert.equal(bad?.type, "error");
  assert.equal(ok?.type, "events.listing");
});
