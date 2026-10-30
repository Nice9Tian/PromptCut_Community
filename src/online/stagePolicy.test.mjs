/**
 * 在线执行用户卡与素材效果卡的隔离策略原文与票据换 cookie 的判定(契约 `docs/plan/online-card-exec-contract.md` 第 3.3、4.1 节)。
 * 跑:node --test src/online/stagePolicy.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_CSP_META, STAGE_CSP_HEADER_ONLY_DIRECTIVE, MEDIA_COOKIE, MEDIA_COOKIE_MAX_AGE_S, MEDIA_PROXY_BASE, ASSET_API_PREFIX,
  stageCspHeader, editorCspHeader, stageSecurityHeaders, editorSecurityHeaders, isSid, isTicketShaped, mediaGrantUrl, mediaSBase, mediaGrantCookie,
  mediaSRoute, cookieValue,
} from "./stagePolicy.mjs";

const EDITOR = "https://x.io";
const SID = "0123456789abcdef0123456789abcdef";
const HASH = "a".repeat(64);
const TICKET = `v1.${"p".repeat(60)}.${"s".repeat(43)}`;

test("OCS-P-01 舞台允许四类HTTP(S)外链，文档/嵌入边界仍保留", () => {
  const policy=stageCspHeader(EDITOR);
  for(const kind of ['script','style','img','font','media','connect']) assert.match(policy,new RegExp(kind+"-src[^;]*http:[^;]*https:"));
  for(const directive of ["frame-src 'none'","object-src 'none'","base-uri 'none'","form-action 'none'","frame-ancestors https://x.io"]) assert.ok(policy.includes(directive),directive);
  assert.doesNotMatch(policy,/webrtc|trusted-types/);
  assert.throws(()=>stageCspHeader('https://x.io/editor'),/不是合法的源/);
  assert.throws(()=>stageCspHeader('javascript:alert(1)'),/不是合法的源/);
  assert.ok(stageCspHeader('https://{{DOMAIN}}',{template:true}).endsWith('frame-ancestors https://{{DOMAIN}}'));
});

test("OCS-P-02 meta与响应头同一资源策略，不要求Trusted Types", () => {
  const header=stageCspHeader(EDITOR);
  assert.equal(header,STAGE_CSP_META+'; frame-ancestors '+EDITOR);
  assert.ok(!STAGE_CSP_META.includes(STAGE_CSP_HEADER_ONLY_DIRECTIVE));
  assert.doesNotMatch(STAGE_CSP_META,/trusted-types|webrtc/);
  assert.ok(!STAGE_CSP_META.includes('"'));
});

test("OCS-P-03 舞台不发出口白名单，保留分源与响应类型安全头", () => {
  const h=stageSecurityHeaders(EDITOR);
  assert.equal(h['connection-allowlist'],undefined);
  assert.equal(h['x-dns-prefetch-control'],'off');
  assert.equal(h['origin-agent-cluster'],'?1');
  assert.equal(h['referrer-policy'],'no-referrer');
  assert.equal(h['x-content-type-options'],'nosniff');
});

test("OCS-P-04 编辑器页只加 frame-src 一条:本源、两个舞台源与第三方登录那一源,不放 blob: / data:", () => {
  // 2026-10-23 加 `https://accounts.google.com`：登录页「通过 Google 继续操作」要在它的 iframe 里画按钮，
  // 不放行时线上控制台报 `Framing 'https://accounts.google.com/' violates ... frame-src`，按钮根本出不来
  const G = "https://accounts.google.com";
  assert.equal(editorCspHeader(["https://s1.x.io", "https://s2.x.io"]), `frame-src 'self' https://s1.x.io https://s2.x.io ${G}`);
  assert.deepEqual(editorSecurityHeaders(["https://s1.x.io", "https://s2.x.io"]), { "content-security-policy": `frame-src 'self' https://s1.x.io https://s2.x.io ${G}` });
  assert.throws(() => editorCspHeader(["https://s1.x.io/a"]), /不是合法的源/);
  assert.ok(!/blob:|data:|\*/.test(editorCspHeader(["https://s1.x.io", "https://s2.x.io"])));
});

test("OCS-P-05 会话号与票据的形状;交接地址与取素材的基址", () => {
  assert.ok(isSid(SID));
  for (const bad of ["", "short", "a".repeat(65), "has/slash0123456789", "../../etc/passwd00", null, 42]) assert.equal(isSid(bad), false, String(bad));
  assert.ok(isTicketShaped(TICKET));
  for (const bad of ["", "v2.aaa.bbb", "v1.aaa", "v1..bbb", `v1.${"a".repeat(3000)}.b`, "v1.a b.c", "v1.a;Path=/.c", null]) assert.equal(isTicketShaped(bad), false, String(bad));
  assert.equal(mediaGrantUrl("https://s1.x.io", SID), `https://s1.x.io/media-s/${SID}/_grant`);
  assert.equal(mediaSBase(SID), `/media-s/${SID}`);
  assert.equal(MEDIA_PROXY_BASE, "/media/api/asset");
  assert.equal(ASSET_API_PREFIX, "/api/asset");
});

test("OCS-P-06 票据换成的 cookie:HttpOnly、Secure、SameSite=Strict,只在本页会话那一段路径上有效,寿命同票据(15 分钟)", () => {
  assert.equal(mediaGrantCookie(SID, TICKET), `${MEDIA_COOKIE}=${TICKET}; Path=/media-s/${SID}/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
  assert.equal(MEDIA_COOKIE_MAX_AGE_S, 900);
  // 本机代理走 http:不带 Secure,别的不变
  assert.equal(mediaGrantCookie(SID, TICKET, { secure: false }), `${MEDIA_COOKIE}=${TICKET}; Path=/media-s/${SID}/; HttpOnly; SameSite=Strict; Max-Age=900`);
});

test("OCS-P-07 /media-s/ 的判定·交接:只认编辑器页的源发来的 POST、票据形状对;预检只对编辑器页的源开", () => {
  const opts = { editorOrigin: EDITOR };
  const p = `/media-s/${SID}/_grant`;
  const ok = mediaSRoute({ method: "POST", pathname: p, origin: EDITOR, authorization: `Bearer ${TICKET}` }, opts);
  assert.equal(ok.kind, "grant");
  assert.equal(ok.headers["set-cookie"], mediaGrantCookie(SID, TICKET));
  assert.equal(ok.headers["access-control-allow-origin"], EDITOR);
  assert.equal(ok.headers["access-control-allow-credentials"], "true");
  assert.equal(ok.headers["cache-control"], "no-store");
  // 舞台自己(或别的源)发来:不发 cookie
  for (const origin of ["https://s1.x.io", "https://evil.io", "https://x.io.evil.io", "https://xxio", null, undefined, "null"]) {
    assert.deepEqual(mediaSRoute({ method: "POST", pathname: p, origin, authorization: `Bearer ${TICKET}` }, opts), { kind: "reject", status: 403 }, String(origin));
  }
  assert.deepEqual(mediaSRoute({ method: "GET", pathname: p, origin: EDITOR, authorization: `Bearer ${TICKET}` }, opts), { kind: "reject", status: 405 });
  for (const authorization of [null, "", "Basic abc", "Bearer ", "Bearer not-a-ticket", `Bearer ${TICKET}; Domain=x.io`]) {
    assert.deepEqual(mediaSRoute({ method: "POST", pathname: p, origin: EDITOR, authorization }, opts), { kind: "reject", status: 400 }, String(authorization));
  }
  assert.equal(mediaSRoute({ method: "OPTIONS", pathname: p, origin: EDITOR }, opts).kind, "preflight");
  assert.deepEqual(mediaSRoute({ method: "OPTIONS", pathname: p, origin: "https://evil.io" }, opts), { kind: "reject", status: 403 });
});

test("OCS-P-08 /media-s/ 的判定·读素材:cookie 换成 Authorization 头转给素材服务的 /api/asset/,只放行 GET / HEAD 与按哈希寻址的素材字节", () => {
  const opts = { editorOrigin: EDITOR };
  const p = `/media-s/${SID}/media/${HASH}`;
  const cookie = `other=1; ${MEDIA_COOKIE}=${TICKET}; x=y`;
  assert.deepEqual(mediaSRoute({ method: "GET", pathname: p, cookie }, opts), { kind: "proxy", path: `/api/asset/media/${HASH}`, authorization: `Bearer ${TICKET}` });
  assert.equal(mediaSRoute({ method: "HEAD", pathname: p, cookie }, opts).kind, "proxy");
  assert.equal(mediaSRoute({ method: "GET", pathname: `${p}.mp4`, cookie }, opts).path, `/api/asset/media/${HASH}.mp4`);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.deepEqual(mediaSRoute({ method, pathname: p, cookie }, opts), { kind: "reject", status: 405 }, method);
  // 没有 cookie、cookie 不是票据的形状
  for (const c of [null, "", "other=1", `${MEDIA_COOKIE}=nope`]) assert.deepEqual(mediaSRoute({ method: "GET", pathname: p, cookie: c }, opts), { kind: "reject", status: 401 }, String(c));
  // 别的命名空间、子路由、上跳、会话号不对:一律 404
  for (const bad of [`/media-s/${SID}/snap/${HASH}`, `/media-s/${SID}/px/${HASH}`, `${p}/chunks`, `${p}/0`, `${p}/complete`, `/media-s/${SID}/media/../admin/inventory`,
    `/media-s/${SID}/admin/inventory`, `/media-s/${SID}/media/${HASH.slice(1)}`, `/media-s/short/media/${HASH}`, "/media-s/", `/media-s/${SID}`, `/media-s/${SID}/`]) {
    assert.deepEqual(mediaSRoute({ method: "GET", pathname: bad, cookie }, opts), { kind: "reject", status: 404 }, bad);
  }
  // 不是这条路由
  for (const other of ["/media/api/asset/media/x", "/editor/stage.html", "/media-sx/a", "/"]) assert.deepEqual(mediaSRoute({ method: "GET", pathname: other, cookie }, opts), { kind: "none" }, other);
});

test("OCS-P-09 从 Cookie 头里取值", () => {
  assert.equal(cookieValue("a=1; pc_rt=v1.x.y; b=2", "pc_rt"), "v1.x.y");
  assert.equal(cookieValue("pc_rtx=1", "pc_rt"), null);
  assert.equal(cookieValue(null, "pc_rt"), null);
  assert.equal(cookieValue("pc_rt=a=b", "pc_rt"), "a=b");
});

test("OCS-P-09 票据的两种形状各自写死:旧共享项目的 v1.<…>.<…>,账号云端项目的恰好 43 个 base64url 字符;别的一概不认", () => {
  const opts = { editorOrigin: EDITOR };
  const grant = `/media-s/${SID}/_grant`;
  const read = `/media-s/${SID}/media/${HASH}`;
  const ACCOUNT = "Aa0_-".repeat(8) + "xyz"; // 43 个字符
  assert.equal(ACCOUNT.length, 43);
  assert.equal(isTicketShaped(ACCOUNT), true);
  assert.equal(isTicketShaped(TICKET), true);
  // 交接:账号票据换成同样属性的 cookie;读素材:cookie 里的账号票据换成 Authorization 头
  const ok = mediaSRoute({ method: "POST", pathname: grant, origin: EDITOR, authorization: `Bearer ${ACCOUNT}` }, opts);
  assert.equal(ok.kind, "grant");
  assert.equal(ok.headers["set-cookie"], `${MEDIA_COOKIE}=${ACCOUNT}; Path=/media-s/${SID}/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
  assert.deepEqual(mediaSRoute({ method: "GET", pathname: read, cookie: `${MEDIA_COOKIE}=${ACCOUNT}` }, opts), { kind: "proxy", path: `/api/asset/media/${HASH}`, authorization: `Bearer ${ACCOUNT}` });
  // 来源、方法的限制对账号票据同样有效
  assert.deepEqual(mediaSRoute({ method: "POST", pathname: grant, origin: "https://evil.io", authorization: `Bearer ${ACCOUNT}` }, opts), { kind: "reject", status: 403 });
  // 不是这两种形状的:长度差一个、带别的字符、两种拼在一起、v1 缺段
  const bad = [ACCOUNT.slice(1), `${ACCOUNT}a`, `${ACCOUNT.slice(0, 42)}.`, `${ACCOUNT.slice(0, 42)}=`, `${ACCOUNT}.${ACCOUNT}`, "v1.abc", "v1..abc", `v2.${ACCOUNT}.abc`, "", "a".repeat(2049)];
  for (const t of bad) {
    assert.equal(isTicketShaped(t), false, JSON.stringify(t.slice(0, 50)));
    assert.deepEqual(mediaSRoute({ method: "POST", pathname: grant, origin: EDITOR, authorization: `Bearer ${t}` }, opts), { kind: "reject", status: 400 }, JSON.stringify(t.slice(0, 50)));
    assert.deepEqual(mediaSRoute({ method: "GET", pathname: read, cookie: `${MEDIA_COOKIE}=${t}` }, opts), { kind: "reject", status: 401 }, JSON.stringify(t.slice(0, 50)));
  }
});
