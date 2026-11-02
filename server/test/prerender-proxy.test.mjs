/*
 * T1a review #14: Editor process forwards `/api/cards/layout` as-is to prerender process,
 * returns `503 NO_AGENT_LANE` if forwarding fails.
 *
 * Forwarding itself is `proxyToPrerender` in `prerender-client.mjs`; set up two bare HTTP servers
 * here (one as editor, one as prerender) to verify: body and response pass through as-is; when
 * prerender is not ready / unreachable, it returns the status code and error code specified by
 * the caller, not generic `PRERENDER_UNAVAILABLE`.
 * Run: `node --test server/test/prerender-proxy.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { proxyToPrerender, setPrerender } from '../prerender-client.mjs';
import { refusingPort } from './fake-ws-kit.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(() => resolve()));
const LAYOUT = { unavailable: { status: 503, code: 'NO_AGENT_LANE', error: 'editor process has no Agent lane' } };

test('prerender ready: the request is forwarded unchanged, the response is returned unchanged', async () => {
  const seen = [];
  const prerender = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body });
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Answered-By': 'prerender' });
      res.end(JSON.stringify({ stage: { width: 1920, height: 1080 }, from: 'prerender' }));
    });
  });
  const editor = http.createServer((req, res) => proxyToPrerender(req, res, LAYOUT));
  const prerenderUrl = await listen(prerender);
  const editorUrl = await listen(editor);
  setPrerender({ url: prerenderUrl, ready: true, error: null });
  try {
    const r = await fetch(`${editorUrl}/api/cards/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 's', localRev: 3, t: 1 }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-answered-by'), 'prerender');
    assert.deepEqual(await r.json(), { stage: { width: 1920, height: 1080 }, from: 'prerender' });
    assert.deepEqual(seen, [{ url: '/api/cards/layout', method: 'POST', body: '{"session":"s","localRev":3,"t":1}' }]);
  } finally {
    setPrerender({ url: null, ready: false, error: null });
    await close(editor); await close(prerender);
  }
});

test('prerender not ready: wait the full waitMs, then respond 503 NO_AGENT_LANE', async () => {
  const editor = http.createServer((req, res) => proxyToPrerender(req, res, { ...LAYOUT, waitMs: 300 }));
  const editorUrl = await listen(editor);
  setPrerender({ url: null, ready: false, error: 'prerender process exited' });
  try {
    const r = await fetch(`${editorUrl}/api/cards/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503);
    const data = await r.json();
    assert.equal(data.code, 'NO_AGENT_LANE');
    assert.equal(data.retryable, true);
    assert.match(data.error, /has no Agent lane/);
  } finally {
    setPrerender({ url: null, ready: false, error: null });
    await close(editor);
  }
});

test('prerender reports ready but cannot be reached: also responds 503 NO_AGENT_LANE; old routes that do not pass unavailable still respond 502 PRERENDER_UNAVAILABLE', async () => {
  // Unreachable address is held by the test itself (RST on connect); do not use "closed ports",
  // as another process might grab them in parallel
  const dead = await refusingPort();
  const deadUrl = `http://127.0.0.1:${dead.port}`;
  const editor = http.createServer((req, res) => req.url.startsWith('/api/cards/layout') ? proxyToPrerender(req, res, LAYOUT) : proxyToPrerender(req, res));
  const editorUrl = await listen(editor);
  setPrerender({ url: deadUrl, ready: true, error: null });
  try {
    const layout = await fetch(`${editorUrl}/api/cards/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(layout.status, 503);
    assert.equal((await layout.json()).code, 'NO_AGENT_LANE');
    const other = await fetch(`${editorUrl}/api/vision/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(other.status, 502);
    assert.equal((await other.json()).code, 'PRERENDER_UNAVAILABLE');
  } finally {
    setPrerender({ url: null, ready: false, error: null });
    await close(editor);
    await dead.close();
  }
});
