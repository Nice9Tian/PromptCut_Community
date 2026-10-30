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

test("ONL-2 设备身份：128 位随机 id、浏览器名 + 系统名 + 随机 4 位，存在页面本地、下次还是同一台", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let n = 0;
  const random = (b) => { for (let i = 0; i < b.length; i++) b[i] = (n += 37) & 255; return b; };
  const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";
  const a = D.loadBrowserDevice({ storage, random, ua });
  assert.match(a.deviceId, /^[A-Za-z0-9_-]{22}$/, "16 字节 base64url");
  assert.match(a.deviceName, /^Chrome · Android · \d{4}$/);
  const b = D.loadBrowserDevice({ storage, random: () => { throw new Error("不该再生成"); }, ua });
  assert.deepEqual(b, a, "存在本地，下次不变");
  store.set(D.DEVICE_KEY, "{坏的");
  const c = D.loadBrowserDevice({ storage, random, ua });
  assert.notEqual(c.deviceId, a.deviceId, "坏了就重新生成");
  const noStore = D.loadBrowserDevice({ storage: null, random, ua });
  assert.match(noStore.deviceId, /^[A-Za-z0-9_-]{22}$/, "存不了也能用（只这一次）");
});

test("ONL-3 浏览器名与系统名：常见 UA 与 iPad 报桌面 UA", () => {
  const L = D.browserLabel;
  assert.deepEqual(L("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"), { browser: "Safari", os: "iOS" });
  assert.deepEqual(L("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", null, 5), { browser: "Safari", os: "iPadOS" });
  assert.deepEqual(L("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", null, 0), { browser: "Safari", os: "macOS" });
  assert.deepEqual(L("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"), { browser: "Edge", os: "Windows" });
  assert.deepEqual(L("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0 Mobile Safari/537.36 MicroMessenger/8.0.49"), { browser: "微信", os: "Android" });
  assert.deepEqual(L("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"), { browser: "Firefox", os: "Linux" });
  assert.deepEqual(L(""), { browser: "浏览器", os: "未知系统" });
});

test("ONL-4 读 #invite=：合格的放进内存并清掉片段；不合格的也清掉并记为坏链接；没有就不动", () => {
  const calls = [];
  const hist = { state: { k: 1 }, replaceState: (s, _t, url) => calls.push([s, url]) };
  I.captureInviteFromLocation({ hash: `#invite=${CODE}`, pathname: "/editor/", search: "" }, hist);
  assert.deepEqual(calls, [[{ k: 1 }, "/editor/"]], "片段清掉，路径与查询串保留");
  assert.deepEqual(I.peekCapturedInvite(), { code: CODE, doc: null });
  assert.deepEqual(I.takeCapturedInvite(), { code: CODE, doc: null });
  assert.equal(I.takeCapturedInvite(), null, "只给一次");

  I.captureInviteFromLocation({ hash: "#invite=short", pathname: "/editor/", search: "?x=1" }, hist);
  assert.deepEqual(calls.at(-1), [{ k: 1 }, "/editor/?x=1"]);
  assert.deepEqual(I.takeCapturedInvite(), { bad: true });

  const before = calls.length;
  I.captureInviteFromLocation({ hash: "#other=1", pathname: "/editor/", search: "" }, hist);
  assert.equal(calls.length, before, "没有 invite= 的片段不动");
  assert.equal(I.takeCapturedInvite(), null);
  assert.deepEqual(I.inviteFromHash(`#a=1&invite=${CODE}`), { code: CODE, doc: null }, "与别的参数并列");
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}=`), { bad: true }, "带 = 填充的不认");
});

test("ONL-4b 链接里的 doc=：文档服务的路径照着读，页面不猜（2026-10-26 用户定，旧链接不兼容）", () => {
  // 局域网主机的文档服务在 /docservice，托管端在 /hosted/ —— 两种不一样，所以写进链接
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}&doc=%2Fdocservice`), { code: CODE, doc: "/docservice" });
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}&doc=%2Fhosted%2F`), { code: CODE, doc: "/hosted/" });
  assert.deepEqual(I.inviteFromHash(`#doc=%2Fdocservice&invite=${CODE}`), { code: CODE, doc: "/docservice" }, "顺序不限");
  // 旧链接没带：doc 为 null，由调用方当失效（JoinForm 的 oldLink）
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}`), { code: CODE, doc: null }, "旧链接");
  // 不以 / 开头的、转义坏了的都不认，免得拼出一条跑偏的地址
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}&doc=docservice`), { code: CODE, doc: null }, "不以 / 开头的不认");
  assert.deepEqual(I.inviteFromHash(`#invite=${CODE}&doc=%E0%A4%A`), { code: CODE, doc: null }, "转义坏了的不认");
  // 源 + 路径 → 文档服务基址
  assert.equal(I.docBaseOf("http://192.168.1.23:5190", "/docservice"), "http://192.168.1.23:5190/docservice");
  assert.equal(I.docBaseOf("https://h.example/", "/hosted/"), "https://h.example/hosted/", "末尾斜杠按路径原样留");
  assert.equal(I.docBaseOf("https://h.example", "docservice"), "https://h.example/docservice", "路径没带 / 也补上");
});

test("ONL-5 粘贴的邀请链接：取源、邀请码与文档服务路径；格式不对回 null", () => {
  assert.deepEqual(I.parseInviteLink(`https://203-0-113-16.sslip.io/editor#invite=${CODE}&doc=%2Fhosted%2F`),
    { origin: "https://203-0-113-16.sslip.io", code: CODE, doc: "/hosted/" });
  assert.deepEqual(I.parseInviteLink(`  来加入吧 http://192.168.1.23:5190/editor#invite=${CODE}&doc=%2Fdocservice 点开就行`),
    { origin: "http://192.168.1.23:5190", code: CODE, doc: "/docservice" }, "夹在文字里的局域网链接");
  assert.deepEqual(I.parseInviteLink(`http://127.0.0.1:5633/editor/#invite=${CODE}`),
    { origin: "http://127.0.0.1:5633", code: CODE, doc: null }, "旧链接：doc 为 null，由调用方当失效");
  assert.equal(I.parseInviteLink("https://h.example/editor"), null, "没有邀请码");
  assert.equal(I.parseInviteLink(`https://h.example/editor?invite=${CODE}`), null, "查询串里的不认（邀请码只放片段）");
  assert.equal(I.parseInviteLink(`ftp://h.example/editor#invite=${CODE}`), null);
  assert.equal(I.parseInviteLink("随便一段字"), null);
  // 签发：路径一并写进链接
  assert.equal(I.inviteLinkOf("https://h.example/", CODE, "/hosted/"), `https://h.example/editor#invite=${CODE}&doc=%2Fhosted%2F`, "托管端:页面在 /editor");
  assert.equal(I.inviteLinkOf("http://192.168.1.23:5190", CODE, "/docservice"), `http://192.168.1.23:5190/#invite=${CODE}&doc=%2Fdocservice`, "局域网主机:页面在根下,没有 /editor");
  assert.equal(I.editorPathFor("/hosted/"), "/editor");
  assert.equal(I.editorPathFor("/docservice"), "/");
  // 拼了再解，回到原样
  const link = I.inviteLinkOf("http://192.168.1.23:5190", CODE, "/docservice");
  assert.equal(link, `http://192.168.1.23:5190/#invite=${CODE}&doc=%2Fdocservice`);
  assert.deepEqual(I.parseInviteLink(link), { origin: "http://192.168.1.23:5190", code: CODE, doc: "/docservice" });
});

test("ONL-6 托管端地址：文档服务在源下的 /hosted/，WebSocket 地址保留末尾斜杠", () => {
  assert.equal(I.hostedDocBaseOf("https://203-0-113-16.sslip.io"), "https://203-0-113-16.sslip.io/hosted/");
  assert.equal(I.hostedWsUrlOf("https://203-0-113-16.sslip.io/hosted/"), "wss://203-0-113-16.sslip.io/hosted/");
  assert.equal(I.hostedWsUrlOf("http://127.0.0.1:5633/hosted/"), "ws://127.0.0.1:5633/hosted/");
  assert.equal(I.hostedWsUrlOf("http://203.0.113.16:8787/"), "ws://203.0.113.16:8787/");
});
