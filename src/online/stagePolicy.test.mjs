/**
 * Original text of the isolation policy for executing user cards and media effect cards online,
 * and determination of exchanging tickets for cookies (contract `docs/plan/online-card-exec-contract.md`
 * Sections 3.3 and 4.1).
 * Run: node --test src/online/stagePolicy.test.mjs
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

test("OCS-P-01 The stage allows four kinds of HTTP(S) external links, while the document/embed boundary is still kept", () => {
  const policy=stageCspHeader(EDITOR);
  for(const kind of ['script','style','img','font','media','connect']) assert.match(policy,new RegExp(kind+"-src[^;]*http:[^;]*https:"));
  for(const directive of ["frame-src 'none'","object-src 'none'","base-uri 'none'","form-action 'none'","frame-ancestors https://x.io"]) assert.ok(policy.includes(directive),directive);
  assert.doesNotMatch(policy,/webrtc|trusted-types/);
  assert.throws(()=>stageCspHeader('https://x.io/editor'),/not a valid origin/);
  assert.throws(()=>stageCspHeader('javascript:alert(1)'),/not a valid origin/);
  assert.ok(stageCspHeader('https://{{DOMAIN}}',{template:true}).endsWith('frame-ancestors https://{{DOMAIN}}'));
});

test("OCS-P-02 The meta tag and response header carry the same resource policy, without requiring Trusted Types", () => {
  const header=stageCspHeader(EDITOR);
  assert.equal(header,STAGE_CSP_META+'; frame-ancestors '+EDITOR);
  assert.ok(!STAGE_CSP_META.includes(STAGE_CSP_HEADER_ONLY_DIRECTIVE));
  assert.doesNotMatch(STAGE_CSP_META,/trusted-types|webrtc/);
  assert.ok(!STAGE_CSP_META.includes('"'));
});

test("OCS-P-03 The stage sends no egress allowlist, and keeps the per-origin and per-response-type security headers", () => {
  const h=stageSecurityHeaders(EDITOR);
  assert.equal(h['connection-allowlist'],undefined);
  assert.equal(h['x-dns-prefetch-control'],'off');
  assert.equal(h['origin-agent-cluster'],'?1');
  assert.equal(h['referrer-policy'],'no-referrer');
  assert.equal(h['x-content-type-options'],'nosniff');
});

test("OCS-P-04 The editor page adds only one frame-src entry: its own origin, the two stage origins and the third-party login origin, without blob: / data:", () => {
  // 2026-10-23 add `https://accounts.google.com`: login page "Continue with Google" needs to render
  // a button in its iframe; when not allowed, online console reports
  // `Framing 'https://accounts.google.com/' violates ... frame-src`, and the button does not appear at all
  const G = "https://accounts.google.com";
  assert.equal(editorCspHeader(["https://s1.x.io", "https://s2.x.io"]), `frame-src 'self' https://s1.x.io https://s2.x.io ${G}`);
  assert.deepEqual(editorSecurityHeaders(["https://s1.x.io", "https://s2.x.io"]), { "content-security-policy": `frame-src 'self' https://s1.x.io https://s2.x.io ${G}` });
  assert.throws(() => editorCspHeader(["https://s1.x.io/a"]), /not a valid origin/);
  assert.ok(!/blob:|data:|\*/.test(editorCspHeader(["https://s1.x.io", "https://s2.x.io"])));
});

test("OCS-P-05 Shape of the session id and ticket; the handoff address and the base for fetching media", () => {
  assert.ok(isSid(SID));
  for (const bad of ["", "short", "a".repeat(65), "has/slash0123456789", "../../etc/passwd00", null, 42]) assert.equal(isSid(bad), false, String(bad));
  assert.ok(isTicketShaped(TICKET));
  for (const bad of ["", "v2.aaa.bbb", "v1.aaa", "v1..bbb", `v1.${"a".repeat(3000)}.b`, "v1.a b.c", "v1.a;Path=/.c", null]) assert.equal(isTicketShaped(bad), false, String(bad));
  assert.equal(mediaGrantUrl("https://s1.x.io", SID), `https://s1.x.io/media-s/${SID}/_grant`);
  assert.equal(mediaSBase(SID), `/media-s/${SID}`);
  assert.equal(MEDIA_PROXY_BASE, "/media/api/asset");
  assert.equal(ASSET_API_PREFIX, "/api/asset");
});

test("OCS-P-06 The cookie the ticket is exchanged for: HttpOnly, Secure, SameSite=Strict, valid only on the path segment of this page session, with the same lifetime as the ticket (15 minutes)", () => {
  assert.equal(mediaGrantCookie(SID, TICKET), `${MEDIA_COOKIE}=${TICKET}; Path=/media-s/${SID}/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
  assert.equal(MEDIA_COOKIE_MAX_AGE_S, 900);
  // Local proxy uses http: does not include Secure, everything else unchanged
  assert.equal(mediaGrantCookie(SID, TICKET, { secure: false }), `${MEDIA_COOKIE}=${TICKET}; Path=/media-s/${SID}/; HttpOnly; SameSite=Strict; Max-Age=900`);
});

test("OCS-P-07 /media-s/ decision, handoff: only accepts a POST from the editor page's origin with a correctly shaped ticket; preflight is open only to the editor page's origin", () => {
  const opts = { editorOrigin: EDITOR };
  const p = `/media-s/${SID}/_grant`;
  const ok = mediaSRoute({ method: "POST", pathname: p, origin: EDITOR, authorization: `Bearer ${TICKET}` }, opts);
  assert.equal(ok.kind, "grant");
  assert.equal(ok.headers["set-cookie"], mediaGrantCookie(SID, TICKET));
  assert.equal(ok.headers["access-control-allow-origin"], EDITOR);
  assert.equal(ok.headers["access-control-allow-credentials"], "true");
  assert.equal(ok.headers["cache-control"], "no-store");
  // Sent from stage itself (or another origin): do not send cookie
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

test("OCS-P-08 /media-s/ decision, reading media: the cookie is swapped for an Authorization header and forwarded to the asset service's /api/asset/, allowing only GET / HEAD and media bytes addressed by hash", () => {
  const opts = { editorOrigin: EDITOR };
  const p = `/media-s/${SID}/media/${HASH}`;
  const cookie = `other=1; ${MEDIA_COOKIE}=${TICKET}; x=y`;
  assert.deepEqual(mediaSRoute({ method: "GET", pathname: p, cookie }, opts), { kind: "proxy", path: `/api/asset/media/${HASH}`, authorization: `Bearer ${TICKET}` });
  assert.equal(mediaSRoute({ method: "HEAD", pathname: p, cookie }, opts).kind, "proxy");
  assert.equal(mediaSRoute({ method: "GET", pathname: `${p}.mp4`, cookie }, opts).path, `/api/asset/media/${HASH}.mp4`);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.deepEqual(mediaSRoute({ method, pathname: p, cookie }, opts), { kind: "reject", status: 405 }, method);
  // No cookie, or cookie is not shaped like a ticket
  for (const c of [null, "", "other=1", `${MEDIA_COOKIE}=nope`]) assert.deepEqual(mediaSRoute({ method: "GET", pathname: p, cookie: c }, opts), { kind: "reject", status: 401 }, String(c));
  // Other namespaces, subroutes, path traversals, incorrect session id: always 404
  for (const bad of [`/media-s/${SID}/snap/${HASH}`, `/media-s/${SID}/px/${HASH}`, `${p}/chunks`, `${p}/0`, `${p}/complete`, `/media-s/${SID}/media/../admin/inventory`,
    `/media-s/${SID}/admin/inventory`, `/media-s/${SID}/media/${HASH.slice(1)}`, `/media-s/short/media/${HASH}`, "/media-s/", `/media-s/${SID}`, `/media-s/${SID}/`]) {
    assert.deepEqual(mediaSRoute({ method: "GET", pathname: bad, cookie }, opts), { kind: "reject", status: 404 }, bad);
  }
  // Not this route
  for (const other of ["/media/api/asset/media/x", "/editor/stage.html", "/media-sx/a", "/"]) assert.deepEqual(mediaSRoute({ method: "GET", pathname: other, cookie }, opts), { kind: "none" }, other);
});

test("OCS-P-09 Extract a value from the Cookie header", () => {
  assert.equal(cookieValue("a=1; pc_rt=v1.x.y; b=2", "pc_rt"), "v1.x.y");
  assert.equal(cookieValue("pc_rtx=1", "pc_rt"), null);
  assert.equal(cookieValue(null, "pc_rt"), null);
  assert.equal(cookieValue("pc_rt=a=b", "pc_rt"), "a=b");
});

test("OCS-P-09 the two ticket shapes are each hard-coded: v1.<…>.<…> for legacy shared projects, exactly 43 base64url characters for account cloud projects; anything else is rejected", () => {
  const opts = { editorOrigin: EDITOR };
  const grant = `/media-s/${SID}/_grant`;
  const read = `/media-s/${SID}/media/${HASH}`;
  const ACCOUNT = "Aa0_-".repeat(8) + "xyz"; // 43 characters
  assert.equal(ACCOUNT.length, 43);
  assert.equal(isTicketShaped(ACCOUNT), true);
  assert.equal(isTicketShaped(TICKET), true);
  // Handoff: exchange account ticket for cookie with same attributes;
  // read asset: exchange account ticket in cookie for Authorization header
  const ok = mediaSRoute({ method: "POST", pathname: grant, origin: EDITOR, authorization: `Bearer ${ACCOUNT}` }, opts);
  assert.equal(ok.kind, "grant");
  assert.equal(ok.headers["set-cookie"], `${MEDIA_COOKIE}=${ACCOUNT}; Path=/media-s/${SID}/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
  assert.deepEqual(mediaSRoute({ method: "GET", pathname: read, cookie: `${MEDIA_COOKIE}=${ACCOUNT}` }, opts), { kind: "proxy", path: `/api/asset/media/${HASH}`, authorization: `Bearer ${ACCOUNT}` });
  // Origin and method restrictions are equally effective for account tickets
  assert.deepEqual(mediaSRoute({ method: "POST", pathname: grant, origin: "https://evil.io", authorization: `Bearer ${ACCOUNT}` }, opts), { kind: "reject", status: 403 });
  // Not of these two shapes: off by one in length, contains other characters, two spliced together,
  // v1 missing segment
  const bad = [ACCOUNT.slice(1), `${ACCOUNT}a`, `${ACCOUNT.slice(0, 42)}.`, `${ACCOUNT.slice(0, 42)}=`, `${ACCOUNT}.${ACCOUNT}`, "v1.abc", "v1..abc", `v2.${ACCOUNT}.abc`, "", "a".repeat(2049)];
  for (const t of bad) {
    assert.equal(isTicketShaped(t), false, JSON.stringify(t.slice(0, 50)));
    assert.deepEqual(mediaSRoute({ method: "POST", pathname: grant, origin: EDITOR, authorization: `Bearer ${t}` }, opts), { kind: "reject", status: 400 }, JSON.stringify(t.slice(0, 50)));
    assert.deepEqual(mediaSRoute({ method: "GET", pathname: read, cookie: `${MEDIA_COOKIE}=${t}` }, opts), { kind: "reject", status: 401 }, JSON.stringify(t.slice(0, 50)));
  }
});
