/*
 * T1a 审查 #14:编辑器进程的 `/api/cards/layout` 原样转给预渲染进程,转不过去回 `503 NO_AGENT_LANE`。
 *
 * 转发本身是 `prerender-client.mjs` 的 `proxyToPrerender`;这里架两个裸 http server
 * (一个当编辑器、一个当预渲染),验:body 和回应原样透传;预渲染没就绪 / 连不上时回的
 * 是调用方指定的状态码和错误码,不是通用的 `PRERENDER_UNAVAILABLE`。
 * 跑法:`node --test server/test/prerender-proxy.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { proxyToPrerender, setPrerender } from '../prerender-client.mjs';
import { refusingPort } from './fake-ws-kit.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(() => resolve()));
const LAYOUT = { unavailable: { status: 503, code: 'NO_AGENT_LANE', error: '编辑器进程没有 Agent lane' } };

test('预渲染就绪:请求原样转过去,回应原样带回来', async () => {
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

test('预渲染没就绪:等满 waitMs 回 503 NO_AGENT_LANE', async () => {
  const editor = http.createServer((req, res) => proxyToPrerender(req, res, { ...LAYOUT, waitMs: 300 }));
  const editorUrl = await listen(editor);
  setPrerender({ url: null, ready: false, error: '预渲染进程退出' });
  try {
    const r = await fetch(`${editorUrl}/api/cards/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503);
    const data = await r.json();
    assert.equal(data.code, 'NO_AGENT_LANE');
    assert.equal(data.retryable, true);
    assert.match(data.error, /没有 Agent lane/);
  } finally {
    setPrerender({ url: null, ready: false, error: null });
    await close(editor);
  }
});

test('预渲染报就绪但连不上:同样回 503 NO_AGENT_LANE;不传 unavailable 的老路由照旧 502 PRERENDER_UNAVAILABLE', async () => {
  // 连不上的地址由测试自己占着(连上就 RST);不用「关掉的端口」,并行时它可能被别的进程拿去
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
