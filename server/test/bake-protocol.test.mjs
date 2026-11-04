import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBakeProtocol, scanUsage, readDocLists } from '../../scripts/verify-bake-protocol.mjs';

// J2: Prerender page driver protocol only goes through window.__*, manifest is documented in
// docs/guides/bake-page-protocol.md.
// Adding a window.__ call on the Node side without updating the manifest must fail here.
test('every window.__* the bake page protocol uses is listed in docs/guides/bake-page-protocol.md', () => {
  const { problems } = verifyBakeProtocol();
  assert.deepEqual(problems, []);
});

test('the two columns cover the scan and stay disjoint', () => {
  const usage = scanUsage();
  const { html, png } = readDocLists();
  assert.ok(usage.size > 0, 'The scanned files should contain window.__* calls');
  assert.deepEqual([...html].filter(name => png.has(name)), []);
  assert.deepEqual([...usage.keys()].filter(name => !html.has(name) && !png.has(name)), []);
  // HTML path cannot leave only the puppeteer-only section: key steps to generate snapshots and
  // advance must be on the HTML path.
  for (const name of ['__pcReady', '__pcSetT', '__bfSettle', '__pcCreateSnapshot', '__pcPrepareFrameMedia']) {
    assert.ok(html.has(name), `${name} should be in the "required by the HTML path" column`);
  }
});
