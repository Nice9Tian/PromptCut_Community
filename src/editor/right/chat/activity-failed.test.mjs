import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 出错留痕:失败的一轮,「Agent 操作」面板不能只写「这一轮没有操作」,气泡里的原因要带 data-pc 以便探针取到
const panel = fs.readFileSync(new URL('./ActivityPanel.tsx', import.meta.url), 'utf8');
const bubble = fs.readFileSync(new URL('./AgentBubble.tsx', import.meta.url), 'utf8');

test('Agent 操作面板:空的一轮若出错,写「这一轮失败了」并带原因', () => {
  const at = panel.indexOf('!live && (m.error || m.outcome === "error")');
  const plain = panel.indexOf('"这一轮没有操作"');
  assert.ok(at > 0 && plain > at, '失败分支必须在「这一轮没有操作」之前');
  assert.match(panel.slice(at, plain), /这一轮失败了,没有执行任何操作/);
  assert.match(panel.slice(at, plain), /m\.error/);
});

test('气泡里的错误行带 data-pc=agent-error', () => {
  assert.match(bubble, /className="ai-message-error" data-pc="agent-error"/);
});
