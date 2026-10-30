import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBakeProtocol, scanUsage, readDocLists } from '../../scripts/verify-bake-protocol.mjs';

// J2: 预渲染页的驱动协议只经 window.__*,清单写在 docs/guides/bake-page-protocol.md。
// 加一个 Node 侧的 window.__ 调用而不更新清单,必须在这里失败。
test('every window.__* the bake page protocol uses is listed in docs/guides/bake-page-protocol.md', () => {
  const { problems } = verifyBakeProtocol();
  assert.deepEqual(problems, []);
});

test('the two columns cover the scan and stay disjoint', () => {
  const usage = scanUsage();
  const { html, png } = readDocLists();
  assert.ok(usage.size > 0, '扫描的文件里应当有 window.__* 调用');
  assert.deepEqual([...html].filter(name => png.has(name)), []);
  assert.deepEqual([...usage.keys()].filter(name => !html.has(name) && !png.has(name)), []);
  // HTML 路不能只剩 puppeteer 专用那一栏:生成快照与推进的关键几步都必须在 HTML 路上。
  for (const name of ['__pcReady', '__pcSetT', '__bfSettle', '__pcCreateSnapshot', '__pcPrepareFrameMedia']) {
    assert.ok(html.has(name), `${name} 应在「HTML 路必需」一栏`);
  }
});
