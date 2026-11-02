/**
 * mcp-server connects to a port that "connects but never replies": must report error on time,
 * cannot hang tool calls on the CLI side.
 * (This happens when port is occupied by another program or that PromptCut is stuck; unreachable
 * cases respond instantly and are not tested here.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));

test('Nobody answers on the port: within the timeout it returns an isError reply that says which port did not respond', async () => {
  const hung = http.createServer(() => { /* Accepts request, never replies */ });
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const port = hung.address().port;
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, PROMPTCUT_PORT: String(port), PROMPTCUT_BRIDGE_TIMEOUT_MS: '500' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const started = Date.now();
    const reply = new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        const line = buf.split('\n').find((l) => l.includes('"id":7'));
        if (line) resolve(JSON.parse(line));
      });
      setTimeout(() => reject(new Error('No reply received within 10 s: the tool call is hung')), 10000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_project', arguments: {} } }) + '\n');
    const res = await reply;
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, new RegExp(`did not respond on 127\\.0\\.0\\.1:${port}`));
    assert.ok(Date.now() - started < 8000, 'Should return around the timeout');
  } finally {
    child.kill();
    hung.close();
    hung.closeAllConnections?.();
  }
});
