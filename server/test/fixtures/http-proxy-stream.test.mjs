import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pipeHttpProxyResponse } from './http-proxy-stream.mjs';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
});
const close = server => new Promise(resolve => {
  if (!server.listening) return resolve();
  server.close(resolve);
  server.closeAllConnections?.();
});
const within = (promise, label, ms = 1500) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms); })])
    .finally(() => clearTimeout(timer));
};

test('fixture HTTP proxy propagates aborted source and downstream cancel but preserves complete bodies', { timeout: 5000 }, async t => {
  const timers = new Set();
  const sourceClosed = Promise.withResolvers();
  const source = http.createServer((req, res) => {
    if (req.url === '/truncated') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      const timer = setTimeout(() => res.socket?.destroy(), 10);
      timers.add(timer);
      return;
    }
    if (req.url === '/complete') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('complete-body');
      return;
    }
    if (req.url === '/open') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('open');
      res.once('close', sourceClosed.resolve);
    }
  });
  const sourcePort = await listen(source);
  const proxy = http.createServer((req, res) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: sourcePort, path: req.url, method: req.method }, response => {
      pipeHttpProxyResponse(response, res, upstream);
    });
    upstream.once('error', () => {
      if (!res.headersSent && !res.destroyed) { res.writeHead(502); res.end(); }
      else if (!res.destroyed && !res.writableEnded) res.destroy();
    });
    req.once('aborted', () => upstream.destroy());
    res.once('close', () => { if (!res.writableEnded && !upstream.destroyed) upstream.destroy(); });
    req.pipe(upstream);
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await Promise.all([close(proxy), close(source)]);
  });

  const truncated = await within(new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${proxyPort}/truncated`, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('aborted', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), ended: false }));
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), ended: true }));
      response.on('error', () => {});
    });
    request.once('error', reject);
  }), 'truncated-client-abort');
  assert.equal(truncated.status, 200);
  assert.equal(truncated.body, 'partial');
  assert.equal(truncated.ended, false, '上游中途关闭要让真实下游客户端及时观察到截断');

  const complete = await within(new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${proxyPort}/complete`, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      response.once('error', reject);
    });
    request.once('error', reject);
  }), 'complete-response-end');
  assert.deepEqual(complete, { status: 200, body: 'complete-body' }, '正常完整响应仍应完整透传');

  const clientClosedUpstream = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout:upstream-sees-downstream-cancel')), 1500);
    sourceClosed.promise.then(() => { clearTimeout(timer); resolve(true); });
  });
  await within(new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${proxyPort}/open`, response => {
      response.once('data', () => { response.destroy(); resolve(); });
      response.on('error', () => {});
    });
    request.once('error', reject);
  }), 'client-cancel-start');
  assert.equal(await within(clientClosedUpstream, 'upstream-close'), true, '下游取消后应销毁上游请求与响应流');
});
