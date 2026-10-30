/**
 * 草稿独占锁在「换草稿」时放的是哪一把(drafts.ts 的 setActiveDraftId + procLock.ts)。跑:
 *   node --experimental-test-module-mocks --test src/editor/io/draftLock.test.mjs
 *
 * 钉死:开始页 open(id) 的顺序是先 openDraft(id)(里面抢到 id 的锁)再 setActiveDraftId(id)。
 * setActiveDraftId 里「换草稿就放上一份的锁」只能放上一份,绝不能把刚抢到的新锁放掉 ——
 * 否则「新建 → 回首页 → 开草稿」「开 A → 回首页 → 开 B」之后正在编辑的草稿没有锁,
 * 另一个 PromptCut 可以同时打开并整份覆盖它。
 * 同时钉住原来该放的照样放:新建项目、从文件打开(设成 null)、startNew(设成新 id)。
 *
 * fetch 和 Tauri invoke 都是假的,不起服务。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** 服务端 /api/skill-lock 的假账本:哪些草稿锁着 */
const serverLocks = new Set();
/** 外壳那层锁着的路径 */
const shellLocks = new Set();
const calls = [];

mock.module(srcUrl("editor/io/proc.ts"), {
  exports: {
    loadProc: (_text, opts) => ({ id: opts?.legacyId ?? "p", name: "proj" }),
    serializeProc: () => "{}",
    forgetSaveTarget: () => {},
    withFrameSnapshots: async (s) => s,
  },
});
mock.module(srcUrl("store/project.ts"), { exports: { actions: { loadProject: () => {} } } });

globalThis.window = {
  addEventListener: () => {},
  __TAURI__: {
    core: {
      invoke: async (cmd, args) => {
        calls.push(`${cmd}:${args.procPath}`);
        if (cmd === "acquire_proc_lock") shellLocks.add(args.procPath);
        if (cmd === "release_proc_lock") shellLocks.delete(args.procPath);
      },
    },
  },
};

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

globalThis.fetch = async (url, init = {}) => {
  const m = /^\/api\/skill-lock\/(acquire|release)$/.exec(url);
  if (m) {
    const { draftId } = JSON.parse(init.body);
    calls.push(`${m[1]}:${draftId}`);
    if (m[1] === "acquire") {
      if (serverLocks.has(draftId)) return reply(409, { ok: false, error: "被占着" });
      serverLocks.add(draftId);
      return reply(200, { ok: true, file: `D:/drafts/${draftId}.proc.lock` });
    }
    serverLocks.delete(draftId);
    return reply(200, { ok: true });
  }
  if (/^\/api\/projects\//.test(url)) return reply(200, { format: "promptcut-proc" });
  throw new Error(`没料到的请求 ${url}`);
};

const { openDraft, setActiveDraftId, getActiveDraftId, newDraftId } = await import(srcUrl("editor/io/drafts.ts"));
const { lockedDraftId, releaseDraftLock } = await import(srcUrl("editor/io/procLock.ts"));

/** setActiveDraftId 里的放锁不 await,让它跑完再看 */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** 开始页 open(id) 的顺序 */
async function startPageOpen(id) {
  await openDraft(id);
  setActiveDraftId(id);
  await settle();
}

/** 开始页 startNew 的那一句 */
async function startNew() {
  setActiveDraftId(newDraftId());
  await settle();
}

beforeEach(async () => {
  setActiveDraftId(null);
  await releaseDraftLock();
  await settle();
  serverLocks.clear();
  shellLocks.clear();
  calls.length = 0;
});

test("startNew 设过 activeDraftId → 开草稿 D:D 的锁仍被持有", async () => {
  await startNew();
  await startPageOpen("D");
  assert.equal(getActiveDraftId(), "D");
  assert.equal(lockedDraftId(), "D");
  assert.ok(serverLocks.has("D"), "服务端那半的锁还在");
  assert.ok(shellLocks.has("D:/drafts/D.proc.lock"), "外壳那半的锁还在");
  assert.ok(!calls.includes("release:D"), `不该对 D 发 release,实际调用:${calls.join(", ")}`);
});

test("开 A → 开 B:B 持有,A 已放", async () => {
  await startPageOpen("A");
  assert.equal(lockedDraftId(), "A");
  await startPageOpen("B");
  assert.equal(getActiveDraftId(), "B");
  assert.equal(lockedDraftId(), "B");
  assert.deepEqual([...serverLocks], ["B"]);
  assert.deepEqual([...shellLocks], ["D:/drafts/B.proc.lock"]);
  assert.ok(calls.includes("release:A"));
  assert.ok(!calls.includes("release:B"), `不该对 B 发 release,实际调用:${calls.join(", ")}`);
});

test("Shell 的 ?draft= 路径(openDraft 再 setActiveDraftId),之前有 activeDraftId 也保住锁", async () => {
  await startNew();
  await openDraft("S");
  setActiveDraftId("S");
  await settle();
  assert.equal(lockedDraftId(), "S");
  assert.ok(serverLocks.has("S"));
});

test("同一份草稿打开两次:不出错,锁一直在,只抢了一次", async () => {
  await startPageOpen("A");
  await startPageOpen("A");
  assert.equal(lockedDraftId(), "A");
  assert.ok(serverLocks.has("A"));
  assert.equal(calls.filter((c) => c === "acquire:A").length, 1);
  assert.ok(!calls.includes("release:A"));
});

test("开着 A 时新建项目 / 从文件打开(设成 null):A 的锁放掉", async () => {
  await startPageOpen("A");
  setActiveDraftId(null);
  await settle();
  assert.equal(lockedDraftId(), null);
  assert.equal(serverLocks.size, 0);
  assert.equal(shellLocks.size, 0);
  assert.ok(calls.includes("release:A"));
});

test("开着 A 时 startNew(设成新 id):A 的锁放掉", async () => {
  await startPageOpen("A");
  await startNew();
  assert.equal(lockedDraftId(), null);
  assert.equal(serverLocks.size, 0);
  assert.equal(shellLocks.size, 0);
});

test("没开过草稿时设 null / 新 id:不发多余的 release", async () => {
  await startNew();
  setActiveDraftId(null);
  await settle();
  assert.deepEqual(calls, []);
});
