/**
 * 在线浏览器模式的几块纯逻辑（C10a 契约 `docs/plan/c10a-contract.md` 第 2、4 节；`c10a-web` 自测，编号 `ONL-…`）：
 * 纯浏览器设备身份、邀请链接的读取与解析（`/api` 守卫的判定归闭源，那一条在 `cloud/src/online/online-impl-api-guard.test.mjs`）。
 * 契约测试（`C10A-…`）由 `c10a-tests` 分支独立写。
 *
 * 跑：node --test src/online/online-impl.test.mjs
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const D = await import("./device.ts");
const I = await import("./invite.ts");

const CODE = "A".repeat(20) + "b_-" + "9".repeat(20); // 43 个 base64url 字符

test("ONL-2 device identity: 128-bit random id, browser name + OS name + random 4 digits, stored locally in the page, same machine next time", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let n = 0;
  const random = (b) => { for (let i = 0; i < b.length; i++) b[i] = (n += 37) & 255; return b; };
  const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
  const a = D.loadBrowserDevice({ storage, random, ua });
  assert.match(a.deviceId, /^[A-Za-z0-9_-]{22}$/, "16-byte base64url");
  assert.match(a.deviceName, /^Chrome · Android · \d{4}$/);
  const b = D.loadBrowserDevice({ storage, random: () => { throw new Error("must not generate again"); }, ua });
  assert.deepEqual(b, a, "stored locally, unchanged next time");
  store.set(D.DEVICE_KEY, "{corrupt");
  const c = D.loadBrowserDevice({ storage, random, ua });
  assert.notEqual(c.deviceId, a.deviceId, "regenerate if corrupt");
  const noStore = D.loadBrowserDevice({ storage: null, random, ua });
  assert.match(noStore.deviceId, /^[A-Za-z0-9_-]{22}$/, "works even if it cannot be stored (this one time only)");
});

test("ONL-3 browser name and OS name: common UAs, and an iPad reporting a desktop UA", () => {
  const L = D.browserLabel;
  assert.deepEqual(L("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"), { browser: "Safari", os: "iOS" });
  assert.deepEqual(L("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", null, 5), { browser: "Safari", os: "iPadOS" });
  assert.deepEqual(L("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", null, 0), { browser: "Safari", os: "macOS" });
  assert.deepEqual(L("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"), { browser: "Edge", os: "Windows" });
  assert.deepEqual(L("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0 Mobile Safari/537.36 MicroMessenger/8.0.49"), { browser: "WeChat", os: "Android" });
  assert.deepEqual(L("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"), { browser: "Firefox", os: "Linux" });
  assert.deepEqual(L(""), { browser: "Browser", os: "Unknown OS" });
});

test("ONL-4 read #invite=: a valid one goes into memory and the fragment is cleared; an invalid one is also cleared and recorded as a bad link; if absent, leave it alone", () => {
  const calls = [];
  const hist = { state: { k: 1 }, replaceState: (s, _t, url) => calls.push([s, url]) };
  I.captureInviteFromLocation({ hash: `#invite=${CODE}`, pathname: "/editor/", search: "" }, hist);
  assert.deepEqual(calls, [[{ k: 1 }, "/editor/"]], "fragment cleared, path and query string kept");
  assert.deepEqual(I.peekCapturedInvite(), { code: CODE, doc: null });
  assert.deepEqual(I.takeCapturedInvite(), { code: CODE, doc: null });
  assert.equal(I.takeCapturedInvite(), null, "given only once");

  I.captureInviteFromLocation({ hash: "#invite=short", pathname: "/editor/", search: "?x=1" }, hist);
  assert.deepEqual(calls.at(-1), [{ k: 1 }, "/editor/?x=1"]);
  assert.deepEqual(I.takeCapturedInvite(), { bad: true });

  const before = calls.length;
  I.captureInviteFromLocation({ hash: "#other=1", pathname: "/editor/", search: "" }, hist);
  assert.equal(calls.length, before, "a fragment without invite= is left alone");
  assert.equal(I.takeCapturedInvite(), null);
  assert.deepEqual(I.inviteFromHash(`#a=1&invite=${CODE}`), { code: CODE, doc: null }, "alongside other parameters");
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}=`), { bad: true }, "rejected if padded with =");
});

test("ONL-4b doc= in the link: the document service path is read as given, the page does not guess (user decision, 2026-10-26, old links are not compatible)", () => {
  // 局域网主机的文档服务在 /docservice，托管端在 /hosted/ —— 两种不一样，所以写进链接
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}&doc=%2Fdocservice`), { code: CODE, doc: "/docservice" });
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}&doc=%2Fhosted%2F`), { code: CODE, doc: "/hosted/" });
  assert.deepEqual(I.inviteFromHash(`#doc=%2Fdocservice&invite=${CODE}`), { code: CODE, doc: "/docservice" }, "any order");
  // 旧链接没带：doc 为 null，由调用方当失效（JoinForm 的 oldLink）
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}`), { code: CODE, doc: null }, "old link");
  // 不以 / 开头的、转义坏了的都不认，免得拼出一条跑偏的地址
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}&doc=docservice`), { code: CODE, doc: null }, "rejected if it does not start with /");
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}&doc=%E0%A4%A`), { code: CODE, doc: null }, "rejected if the escaping is broken");
  // 源 + 路径 → 文档服务基址
  assert.equal(I.docBaseOf("http://192.168.1.23:5190", "/docservice"), "http://192.168.1.23:5190/docservice");
  assert.equal(I.docBaseOf("https://h.example/", "/hosted/"), "https://h.example/hosted/", "trailing slash kept as in the path");
  assert.equal(I.docBaseOf("https://h.example", "docservice"), "https://h.example/docservice", "add / if the path lacks it");
});

test("ONL-5 pasted invite link: take the origin, invite code and document service path; return null if the format is wrong", () => {
  assert.deepEqual(I.parseInviteLink(`https://203-0-113-16.sslip.io/editor#invite=${CODE}&doc=%2Fhosted%2F`),
    { origin: "https://203-0-113-16.sslip.io", code: CODE, doc: "/hosted/" });
  assert.deepEqual(I.parseInviteLink(`  come join us http://192.168.1.23:5190/editor#invite=${CODE}&doc=%2Fdocservice just click it`),
    { origin: "http://192.168.1.23:5190", code: CODE, doc: "/docservice" }, "LAN link embedded in text");
  assert.deepEqual(I.parseInviteLink(`http://127.0.0.1:5633/editor/#invite=${CODE}`),
    { origin: "http://127.0.0.1:5633", code: CODE, doc: null }, "old link: doc is null, the caller treats it as invalid");
  assert.equal(I.parseInviteLink("https://h.example/editor"), null, "no invite code");
  assert.equal(I.parseInviteLink(`https://h.example/editor?invite=${CODE}`), null, "rejected in the query string (the invite code only goes in the fragment)");
  assert.equal(I.parseInviteLink(`ftp://h.example/editor#invite=${CODE}`), null);
  assert.equal(I.parseInviteLink("some random text"), null);
  // 签发：路径一并写进链接
  assert.equal(I.inviteLinkOf("https://h.example/", CODE, "/hosted/"), `https://h.example/editor#invite=${CODE}&doc=%2Fhosted%2F`, "hosted side: the page is at /editor");
  assert.equal(I.inviteLinkOf("http://192.168.1.23:5190", CODE, "/docservice"), `http://192.168.1.23:5190/#invite=${CODE}&doc=%2Fdocservice`, "LAN host: the page is under the root, no /editor");
  assert.equal(I.editorPathFor("/hosted/"), "/editor");
  assert.equal(I.editorPathFor("/docservice"), "/");
  // 拼了再解，回到原样
  const link = I.inviteLinkOf("http://192.168.1.23:5190", CODE, "/docservice");
  assert.equal(link, `http://192.168.1.23:5190/#invite=${CODE}&doc=%2Fdocservice`);
  assert.deepEqual(I.parseInviteLink(link), { origin: "http://192.168.1.23:5190", code: CODE, doc: "/docservice" });
});

test("ONL-6 hosted side address: the document service is at /hosted/ under the origin, the WebSocket address keeps the trailing slash", () => {
  assert.equal(I.hostedDocBaseOf("https://203-0-113-16.sslip.io"), "https://203-0-113-16.sslip.io/hosted/");
  assert.equal(I.hostedWsUrlOf("https://203-0-113-16.sslip.io/hosted/"), "wss://203-0-113-16.sslip.io/hosted/");
  assert.equal(I.hostedWsUrlOf("http://127.0.0.1:5633/hosted/"), "ws://127.0.0.1:5633/hosted/");
  assert.equal(I.hostedWsUrlOf("http://203.0.113.16:8787/"), "ws://203.0.113.16:8787/");
});
