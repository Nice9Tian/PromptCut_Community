/**
 * mcp-server 连到一个「连得上但没人回话」的端口:要按时报错,不能把 CLI 那边的工具调用挂死。
 * (端口被别的程序占着、或者那个 PromptCut 卡住时就是这样;连不上的情况是秒回的,不在这里测。)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));

test('端口没人回话:在超时之内回一条 isError,说清是哪个端口没回应', async () => {
  const hung = http.createServer(() => { /* 收下请求,永远不回 */ });
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
      setTimeout(() => reject(new Error('10 秒没收到回复:工具调用被挂住了')), 10000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_project', arguments: {} } }) + '\n');
    const res = await reply;
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, new RegExp(`${port}.*没有回应`));
    assert.ok(Date.now() - started < 8000, '应当在超时附近就回来');
  } finally {
    child.kill();
    hung.close();
    hung.closeAllConnections?.();
  }
});
