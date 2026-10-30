import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
let base = "https://assets.example.test/api/asset", ticketCalls = 0;
/** 账号云端项目:项目号,以及账号会话签发的素材票据(`force` 为真时换一张) */
let accountProject = null, accountTicketCalls = [], legacyTicketCalls = 0;
mock.module(srcUrl("editor/media/assetTiers.ts"), { namedExports: {
  remoteAssetBase: () => base,
  hasDocLink: () => true,
  docRequest: async request => { legacyTicketCalls++; assert.deepEqual(request, { type: "auth.ticket", kind: "asset", access: "rw" }); return { type: "auth.ticket.ok", ticket: `ticket-${++ticketCalls}` }; },
  remoteAccountProjectId: () => accountProject,
  remoteAssetTicketInfo: async (force = false) => { accountTicketCalls.push(force); return { ticket: `account-${accountTicketCalls.length}`, exp: Date.now() + 60_000 }; },
} });
mock.module(srcUrl("online/pageFlag.ts"), { namedExports: { onlinePage: () => true } });
const { uploadGeneratedAudio } = await import("./generatedAudioUpload.ts");
const { createNotificationRecipe } = await import("../../kernel/soundEffects.ts");
const { renderSoundEffectWav } = await import("../../audio/soundGeneration.ts");

test("online generated WAV uses only remote media chunks with rw tickets and 401 refresh", async () => {
  const old = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    assert.ok(String(url).startsWith(base + "/media/"));
    assert.match(init.headers.Authorization, /^Bearer ticket-/);
    if (calls.length === 1) return new Response("unauthorized", { status: 401 });
    if (String(url).endsWith("/chunks")) return Response.json({ complete: false, received: [] });
    return Response.json({ ok: true });
  };
  try {
    const wav = await renderSoundEffectWav(createNotificationRecipe(), { yield: () => Promise.resolve() });
    const result = await uploadGeneratedAudio(wav, new AbortController().signal);
    assert.match(result.hash, /^[a-f0-9]{64}$/); assert.equal(result.bytes, wav.length);
    assert.equal(calls.filter(c => c.method === "PUT").length, 1);
    assert.notEqual(calls[0].headers.Authorization, calls[1].headers.Authorization);
    assert.ok(calls.every(c => !c.url.includes("ticket-") && !c.url.startsWith("/api/")));
  } finally { globalThis.fetch = old; }
});

test("online mode without the connected asset service fails before trying any local route", async () => {
  const oldBase = base, oldFetch = globalThis.fetch; base = null;
  globalThis.fetch = async () => { throw new Error("must not fetch"); };
  try { await assert.rejects(uploadGeneratedAudio(new Uint8Array([1]), new AbortController().signal), /尚未连接素材服务/); }
  finally { base = oldBase; globalThis.fetch = oldFetch; }
});

test("账号云端项目:用账号会话签发的素材票据,不签旧的 auth.ticket;401 时强制换一张;请求不带 Cookie", async () => {
  const old = globalThis.fetch;
  const calls = [];
  accountProject = "sp_aaaaaaaaaaaaaaaaaaaaaaaaaa"; accountTicketCalls = []; legacyTicketCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), ...init });
    if (calls.length === 1) return new Response("unauthorized", { status: 401 });
    if (String(url).endsWith("/chunks")) return Response.json({ complete: false, received: [] });
    return Response.json({ ok: true });
  };
  try {
    const wav = await renderSoundEffectWav(createNotificationRecipe(), { yield: () => Promise.resolve() });
    const result = await uploadGeneratedAudio(wav, new AbortController().signal);
    assert.match(result.hash, /^[a-f0-9]{64}$/);
    assert.equal(legacyTicketCalls, 0, "账号项目里不发 auth.ticket(账号连接上会被拒)");
    assert.deepEqual(accountTicketCalls.slice(0, 2), [false, true], "先用手里的,回 401 强制换一张");
    assert.ok(calls.every(c => /^Bearer account-/.test(c.headers.Authorization)));
    assert.notEqual(calls[0].headers.Authorization, calls[1].headers.Authorization);
    assert.ok(calls.every(c => c.credentials === "omit"), "不带网站的登录 Cookie");
    assert.equal(calls.filter(c => c.method === "PUT").length, 1);
    assert.ok(calls.every(c => !c.url.includes("account-")), "票据不进地址");
  } finally { globalThis.fetch = old; accountProject = null; }
});

test("账号云端项目:上传途中换了项目就取消", async () => {
  const old = globalThis.fetch;
  accountProject = "sp_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  globalThis.fetch = async () => { accountProject = "sp_bbbbbbbbbbbbbbbbbbbbbbbbbb"; return Response.json({ complete: false, received: [] }); };
  try { await assert.rejects(uploadGeneratedAudio(new Uint8Array([1, 2, 3]), new AbortController().signal), /已切换/); }
  finally { globalThis.fetch = old; accountProject = null; }
});
