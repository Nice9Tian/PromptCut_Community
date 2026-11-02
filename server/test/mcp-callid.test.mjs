/**
 * c65-integ2: mcp-server passes `_meta["claudecode/toolUseId"]` sent by Claude Code in tools/call as
 * callId to editor (request body of /api/mcp/call); editor puts it into tool call events, and page
 * AI panel matches chat history by it; not passed when absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));

test('MCP-CALLID _meta["claudecode/toolUseId"] of tools/call is passed through unchanged as the callId of /api/mcp/call; if it is missing, callId is omitted', async () => {
  const bodies = [];
  const bridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/mcp/call') bodies.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { ok: true } }));
    });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  const port = bridge.address().port;
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, PROMPTCUT_PORT: String(port), PROMPTCUT_AGENT: 'conv-x' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  const replyOf = (id) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const line = buf.split('\n').find((l) => l.includes(`"id":${id}`));
      if (line) return resolve(JSON.parse(line));
      if (Date.now() - t0 > 10000) return reject(new Error(`No reply for id ${id} received within 10 s`));
      setTimeout(tick, 20);
    };
    tick();
  });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_project', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_01XYZ', progressToken: 3 } } }) + '\n');
    await replyOf(11);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_project', arguments: {} } }) + '\n');
    await replyOf(12);
    const calls = bodies.filter((b) => b.tool === 'get_project');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].callId, 'toolu_01XYZ');
    assert.equal(calls[0].agent, 'conv-x');
    assert.equal('callId' in calls[1], false, 'No callId when _meta is absent');
  } finally {
    child.kill();
    bridge.close();
    bridge.closeAllConnections?.();
  }
});
