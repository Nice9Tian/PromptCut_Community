/**
 * 浏览器版(在线构建)不画应用标题栏(2026-10-22 用户定:不要「显示顶部菜单栏」和 − □ × 三个按钮;桌面版照旧)。
 * 开关是编译期常量 `ONLINE_BUILD`,就对产物核:
 * - 在线产物里没有标题栏的菜单行、窗口按钮、桌面壳命令;
 * - 标题栏「帮助」里只此一处入口的「快捷键」「关于 PromptCut」改住编辑器顶栏的「⋯」菜单,在线产物里有;
 * - 桌面产物里标题栏整套还在,「⋯」菜单里不重复那两项。
 * 产物写进临时目录,不碰 `dist/`、`dist-online/`。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-titlebar-online-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

async function viteBuild(mode, outDir) {
  const { build } = await import('vite');
  const prevCwd = process.cwd();
  process.chdir(ROOT);
  try {
    await build({ root: ROOT, mode, logLevel: 'error', build: { outDir, emptyOutDir: true, reportCompressedSize: false } });
  } finally {
    process.chdir(prevCwd);
  }
}

const bundleText = (dir) => fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, 'assets', f), 'utf8')).join('\n');

test('TITLEBAR-ONLINE-01 在线产物里没有标题栏菜单行、窗口按钮和桌面壳命令,「快捷键」「关于」住进「⋯」菜单', { timeout: 240_000 }, async () => {
  const dir = path.join(OUT, 'dist-online');
  await viteBuild('online', dir);
  const text = bundleText(dir);
  for (const gone of ['titlebar-${', 'pc-titlebar-menus', 'pc-titlebar-window-controls', '应用菜单', '窗口控制', 'pc-window-control', 'desktop_titlebar_command']) {
    assert.equal(text.includes(gone), false, `在线产物里不该还有标题栏的 ${gone}`);
  }
  for (const kept of ['more-shortcuts', 'more-about', '关于 PromptCut']) {
    assert.ok(text.includes(kept), `在线产物里应有 ${kept}(「⋯」菜单里的入口)`);
  }
});

test('TITLEBAR-ONLINE-02 桌面产物里标题栏整套照旧,「⋯」菜单不重复「快捷键」「关于」', { timeout: 240_000 }, async () => {
  const dir = path.join(OUT, 'dist');
  await viteBuild('production', dir);
  const text = bundleText(dir);
  for (const kept of ['titlebar-${', 'pc-titlebar-menus', '应用菜单', '窗口控制', 'pc-window-control', 'desktop_titlebar_command']) {
    assert.ok(text.includes(kept), `桌面产物里标题栏应还有 ${kept}`);
  }
  for (const dup of ['more-shortcuts', 'more-about']) {
    assert.equal(text.includes(dup), false, `桌面产物里「⋯」菜单不该重复 ${dup}`);
  }
});
