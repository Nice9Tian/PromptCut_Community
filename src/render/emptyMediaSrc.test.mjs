// Gatekeeper: <video> / <img> on stage must not bind empty strings to src.
// Run: node --test src/render/emptyMediaSrc.test.mjs
//
// Why guard this: playbackUrl / previewMediaUrl in `mediaTier.ts` returns an empty string when
// "this asset has no available URL yet", and the file header states "callers receiving \"\"
// must not bind src or make requests". But `<video src="">` is not "not binding": the browser
// treats it as "download current page again", and React also reports
// "An empty string (\"\") was passed to the src attribute", breaking the preview tile.
//
// Actually hit on 2026-10-23: before assets are stored, they are set to `pending: true` and
// `url: ""`; local import pending windows are only milliseconds and unnoticeable, but importing
// from a cloud drive takes tens of seconds to minutes, and users reported "preview failed upon adding".
// Root cause: FrameScene's srcOf passed empty strings straight through.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The src bindings in these files must either be constants or handle empty strings */
const GUARDED = ['FrameScene.tsx', 'VideoTrack.tsx'];

/**
 * Extracts all `src={...}` expressions (only handles single curly braces, which is sufficient:
 * neither file has nested braces in src).
 *
 * The negative lookbehind is required: `data-pc-media-src={media.url}` is a data attribute,
 * where empty strings are harmless and should not be matched (without it, `\bsrc` matches `-src=`).
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
      // `srcOf(...)` already handles fallbacks inside the function (guarded by the second test case
      // below); callers do not need to handle it again
      if (/^srcOf\(/.test(expr)) continue;
      // Pattern to handle empty strings: `... || undefined`
      const guarded = /\|\|\s*undefined\s*$/.test(expr);
      // Only cares about sources that actually return empty strings. Sources already guarded
      // by `url ? … : null` on the outside like `src={url}` are not included
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
