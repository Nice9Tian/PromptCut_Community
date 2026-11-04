/**
 * Regression (probe A7): `events.list` sent by page to document service to catch up on tool call
 * history must include project id.
 * Document service (`list` in `server/docservice/modules/events.mjs`) returns bad-message
 * "Invalid projectId" without project id;
 * The account project path previously omitted it in two places (entering project, reconnecting
 * after disconnect); pages reopened after Cloud Agent finished lacked tool call records and
 * "Undo this step".
 *
 * `syncManager.ts` cannot be loaded in Node (requires browser environment); here we check each
 * occurrence in source code to ensure every `events.list` message includes `projectId`,
 * and use document service's events module to confirm omitting project id is indeed rejected and
 * including it fetches successfully.
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

test("EVL-01 every events.list message in syncManager.ts carries projectId", () => {
  const src = fs.readFileSync(path.join(here, "syncManager.ts"), "utf8");
  // Find all `{ type: 'events.list' ... }` object literals (up to the closing brace at the same level)
  const sends = [...src.matchAll(/\{\s*type:\s*["']events\.list["'][^}]*\}/g)].map((m) => m[0]);
  assert.ok(sends.length >= 4, `too few events.list messages found (${sends.length}); if the source's style changed, update this test`);
  for (const s of sends) assert.match(s, /projectId\s*:/, `this events.list does not carry projectId: ${s}`);
});

test("EVL-02 the document service's events.list: without projectId it returns bad-message, with it returns events.listing", async () => {
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
