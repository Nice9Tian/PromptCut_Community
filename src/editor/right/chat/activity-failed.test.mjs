import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 出错留痕:失败的一轮,「Agent 操作」面板不能只写「这一轮没有操作」,气泡里的原因要带 data-pc 以便探针取到
const panel = fs.readFileSync(new URL('./ActivityPanel.tsx', import.meta.url), 'utf8');
const bubble = fs.readFileSync(new URL('./AgentBubble.tsx', import.meta.url), 'utf8');

test('Agent operations panel: if an empty round fails, it shows "This round failed" with the reason', () => {
  const at = panel.indexOf('!live && (m.error || m.outcome === "error")');
  const plain = panel.indexOf('tr("No actions in this round")');
  assert.ok(at > 0 && plain > at, 'The failure branch must come before "No operations this round"');
  assert.match(panel.slice(at, plain), /This round failed, no operations were performed/);
  assert.match(panel.slice(at, plain), /m\.error/);
});

test('The error line in the bubble carries data-pc=agent-error', () => {
  assert.match(bubble, /className="ai-message-error" data-pc="agent-error"/);
});
