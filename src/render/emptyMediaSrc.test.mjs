// 守门:舞台上的 <video> / <img> 不许把空串挂进 src。
// 跑:node --test src/render/emptyMediaSrc.test.mjs
//
// 为什么要守这一条:`mediaTier.ts` 的 playbackUrl / previewMediaUrl 在「这份素材还没有可用地址」时
// 回的是空串,文件头写明「调用方拿到 "" 就不挂 src、不发请求」。可 `<video src="">` 并不是「不挂」——
// 浏览器会把它当成「再下载一遍当前页面」,React 也会报
// 「An empty string ("") was passed to the src attribute」,预览那一格就是坏的。
//
// 2026-10-23 真撞上过:素材入库前挂 `pending: true`、`url: ""`,本地导入的 pending 窗口只有毫秒级看不出来,
// 从网盘导入要拉几十秒到几分钟,用户报「添加的时候预览失败」。根因是 FrameScene 的 srcOf 把空串原样传了下去。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 这些文件里的 src 绑定要么是常量，要么必须兜住空串 */
const GUARDED = ['FrameScene.tsx', 'VideoTrack.tsx'];

/**
 * 取出所有 `src={...}` 的表达式（只处理单层花括号，够用：这两份文件里没有嵌套花括号的 src）。
 *
 * 前面那个否定回顾是必须的：`data-pc-media-src={media.url}` 是 data 属性，空串无害，不能跟着一起管
 * （不加的话 `\bsrc` 会从 `-src=` 里匹配出来）。
 */
function srcBindings(source) {
  return [...source.matchAll(/(?<![-\w])src=\{([^{}]*)\}/g)].map((m) => m[1].trim());
}

for (const file of GUARDED) {
  test(`${file}: src binding never attaches an empty string`, () => {
    const source = fs.readFileSync(path.join(HERE, file), 'utf8');
    const bindings = srcBindings(source);
    assert.ok(bindings.length > 0, `No src={...} found in ${file}, the gatekeeper test should be updated`);

    for (const expr of bindings) {
      // `srcOf(...)` 自己在函数里兜过了（下面第二条用例守着它），调用处不用再兜一遍
      if (/^srcOf\(/.test(expr)) continue;
      // 兜住空串的写法：`... || undefined`
      const guarded = /\|\|\s*undefined\s*$/.test(expr);
      // 只管真正会回空串的那几个来源。像 `src={url}` 这种外面已经有 `url ? … : null` 守着的，不在此列
      const risky = /playbackUrl\(|previewMediaUrl\(|originalMediaUrl\(|plan\.load/.test(expr);
      if (!risky) continue;
      assert.ok(
        guarded,
        `src={${expr}} in ${file} may be an empty string but is not guarded.`
        + `playbackUrl returns "" when the asset has no URL yet; attaching it directly to src makes the browser re-download the whole page and breaks the preview.`
        + `Change to \`${expr} || undefined\`.`,
      );
    }
  });
}

test('srcOf must guard it too (the one in FrameScene is the root cause)', () => {
  const source = fs.readFileSync(path.join(HERE, 'FrameScene.tsx'), 'utf8');
  const line = source.split('\n').find((l) => l.includes('const srcOf'));
  assert.ok(line, 'srcOf not found in FrameScene, the gatekeeper test should be updated');
  assert.match(line, /\|\|\s*undefined/, 'srcOf must turn an empty playbackUrl string into undefined');
});
