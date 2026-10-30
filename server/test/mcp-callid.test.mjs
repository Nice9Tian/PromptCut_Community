/**
 * c65-integ2:mcp-server 把 Claude Code 在 tools/call 里带的 `_meta["claudecode/toolUseId"]` 当 callId 转给编辑器
 * (/api/mcp/call 的请求体),编辑器把它放进工具调用事件,页面 AI 栏按它对上聊天记录;没带时不转。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));

test('MCP-CALLID tools/call 的 _meta["claudecode/toolUseId"] 原样转成 /api/mcp/call 的 callId;没带就不带', async () => {
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
      if (Date.now() - t0 > 10000) return reject(new Error(`10 秒没收到 id ${id} 的回复`));
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
    assert.equal('callId' in calls[1], false, '没带 _meta 就不带 callId');
  } finally {
    child.kill();
    bridge.close();
    bridge.closeAllConnections?.();
  }
});
