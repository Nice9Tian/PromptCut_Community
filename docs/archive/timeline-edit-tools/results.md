# Timeline edit tools: verification results

Branch `promptcut/timeline-edit-tools` on `main` @ e0e8a2c, 2026-11-20, Ubuntu 26.04.1 LTS, Node 24.22.3. Commands were run from the repository root. Chrome is the machine's puppeteer install (`PUPPETEER_CACHE_DIR`), sandboxed.

## Build and tests

| Item | Command | Result |
|---|---|---|
| Type check | `npx tsc -b --force` | exit 0, no errors |
| Build | `npm run build` | exit 0 (`✓ built`) |
| Affected tests | `npm test -- <the 35 files below>` | exit 0; 313 tests, 312 pass, 0 fail, 1 skipped |
| Full suite | `npm test` | 6122 tests, 6092 pass, 1 fail, 29 skipped. The failure was this branch's new probe: one ffmpeg call without `windowsHide` (`server/test/windows-hide-silent-spawn.test.mjs`). Fixed; that test passes in the affected run above |

The affected files: the new tests `src/kernel/mediaPicture.test.mjs`, `src/store/actions/picture.test.mjs`, `src/editor/timeline/editTools.test.mjs`, `src/editor/timeline/cropRect.test.mjs`, `src/render/mediaPicture.test.mjs`, `src/mcp/handlers/updateClipPicture.test.mjs`; the tests this branch extends, `src/kernel/layout.test.mjs`, `src/render/layerInputSig.test.mjs`, `server/test/below-stream.test.mjs`, `server/test/export-compose.test.mjs`, `src/editor/readOnly.test.mjs`; and the tests of code this branch touches: splitting (`src/store/actions/cutSegments.test.mjs`, `src/kernel/clipAudioState.test.mjs`, `src/store/actions/sound.test.mjs`, `src/kernel/clipVolume.test.mjs`, `src/audio/cardAudio.test.mjs`, `src/editor/io/cardAudioGeneration.test.mjs`, `server/test/clip-speed.test.mjs`), `update_clip` and the tool tables (`src/mcp/handlers/updateClipPatch.test.mjs`, `src/mcp/handlers/parkedCutEdit.test.mjs`, `server/test/tool-schema.test.mjs`, `server/test/mcp-routes.test.mjs`, `server/test/cloud-agent-tools.test.mjs`), interface text (`src/i18n/i18n.test.mjs`, `src/i18n/interface-text.test.mjs`), layering (`src/layering.test.mjs`, `src/pageNodeImports.test.mjs`), media layers and signatures (`src/render/mediaDrive.test.mjs`, `src/render/MissingMaterial.test.mjs`, `src/render/emptyMediaSrc.test.mjs`, `src/render/streamInputSig.test.mjs`), keys and merge labels (`src/editor/saveLock.test.mjs`, `src/editor/sync/mergeItems.test.mjs`), and `server/test/windows-hide-silent-spawn.test.mjs`, `server/test/community-boundary.test.mjs`.

## Probes and render checks

| Check | Command | Result |
|---|---|---|
| `scripts/probes/timeline-edit-tools-probe.mjs` (new) | `xvfb-run -a node scripts/probes/timeline-edit-tools-probe.mjs --out <dir>` | exit 0, `"ok":true`. Toolbar U1–U6 all pass (buttons enabled / disabled with reasons, Split + Ctrl+B + undo, Mirror on and off, Rotate about the center + undo, Crop 1:1 → square crop and centered 360 × 360 box, stage `<video>` at 177.78 % / −38.89 % with `matrix(-1, 0, 0, 1, 0, 0)`). Export: Chrome export 22 / 22 sampled points, `--media ffmpeg` export 22 / 22 |
| `scripts/verify-unified-frames.mjs` | `PC_FRAME_TEST_URL=http://127.0.0.1:5213 PC_FRAME_MEDIA_DIR=<dev server media dir> node scripts/verify-unified-frames.mjs` | exit 0, `PASS` |
| `scripts/verify-determinism.mjs` | `node scripts/verify-determinism.mjs --url "http://127.0.0.1:5213/?export=1"` | exit 0, 1800 / 1800 frames identical |

Not run: the pixel comparison against `main` and the prerender probes (the other two G0-R items, `docs/plan/Master-Execution-Plan.md` section 8). Clips without a crop or mirror render through the old code: the media element gets the same style object, key for key, and the 3D paths the same cover arithmetic (`src/render/mediaPicture.test.mjs`); signatures and stream keys of clips without them are unchanged verbatim (`layerInputSig.test.mjs`, `below-stream.test.mjs`).

## Images

- `toolbar.png`: the four tools at the left of the timeline toolbar (Split, Mirror shown pressed, Rotate, Crop), then the existing row height control.
- `crop-dialog.jpg`: the crop dialog on the probe's quadrant picture with 1:1 picked.
- `editor-cropped-mirrored.jpg`: the editor after Crop 1:1 and Mirror on clip A: the stage shows the centered square, mirrored (green and yellow now on the left).
- `export-frames.png`: the middle frame of clips A–G of the probe project (untouched, mirrored, top half, top half mirrored, turned 90°, PNG cropped and mirrored, square crop in its square box). Top row the Chrome export, bottom row the `--media ffmpeg` export. The gray versus black background and the darker green of the bottom row are that path's own (its background color and color matrix), not part of this change.
