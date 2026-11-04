/**
 * Real browser + vision HTTP error transport, not a stubbed shader.
 *
 * Tests that "GLSL compilation diagnostics are passed out as-is via frameReady → see_frames". Media
 * effect cards follow the same path as the former Python card (`CardGpuExecutor` compiles on
 * WebGL), so assertions have not changed by a single word.
 *
 * There is no "register" function in the repository, so media effect cards can only be files: the
 * script first writes this media effect card with an intentionally incorrect uniform to a temporary
 * file `src/cards/user/__probe-broken-shader.tsx` (**written before createServer** to avoid racing
 * vite's file discovery), then uses `server.ssrLoadModule` to load it in and pass it as `getCard`
 * to `applyCardDefinition` (bare Node `import('*.tsx')` triggers ERR_UNKNOWN_FILE_EXTENSION;
 * `scripts/` has no TS loader). Deleted after the run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { applyCardDefinition } from '../src/kernel/cardAuthoring.mjs';

const CARD_ID = '__probe-broken-shader';
const cardFile = path.join(process.cwd(), 'src', 'cards', 'user', `${CARD_ID}.tsx`);
const CARD_SOURCE = `import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

/** Temporary card for the verify script: deliberately references an undeclared uniform, to check that the compile diagnostics are passed through unchanged. */
export const brokenShader: CardDef<Record<string, never>> = {
  id: "${CARD_ID}",
  name: "Compile diagnostics probe",
  description: "A GLSL media effect card with a deliberately wrong uniform, used only by verify-card-gpu-diagnostics",
  source: "user",
  kind: "animation",
  frameMode: "direct",
  defaults: {},
  controls: [],
  card: (_sources, t) => glsl("void main(){outColor=vec4(missing_uniform,0.,0.,1.);}", [], { u_time: t }),
};
`;

fs.mkdirSync(path.dirname(cardFile), { recursive: true });
fs.writeFileSync(cardFile, CARD_SOURCE);

process.env.PROMPTCUT_ROLE = 'prerender';
// Port can be overridden with PC_VERIFY_PORT: avoid collisions when running multiple verification
// scripts in parallel on the same machine
const port = Number(process.env.PC_VERIFY_PORT) || 5199;
const server = await createServer({ configFile: 'vite.prerender.config.ts', server: { host: '127.0.0.1', port, strictPort: true } });
try {
  await server.listen();
  const mod = await server.ssrLoadModule(`/src/cards/user/${CARD_ID}.tsx`);
  // ssrLoadModule returns a module namespace, not a function: extract CardDef inside and wrap it as getCard
  const definition = Object.values(mod).find((value) => value && typeof value === 'object' && value.id === CARD_ID);
  assert.ok(definition, `The temporary media effect card does not export a CardDef with id ${CARD_ID}`);
  const getCard = (id) => (id === definition.id ? definition : undefined);

  const base = { id: 'shader-error-' + randomUUID(), width: 64, height: 64, fps: 10, duration: 1, themeId: 'default', media: [], tracks: [{ id: 'main', kind: 'video', clips: [] }] };
  const project = applyCardDefinition(base, { cardId: CARD_ID, trackId: 'main', start: 0, end: 1, newClipId: 'broken-clip', nodeId: 'broken-node' }, getCard).project;

  const response = await fetch(`http://127.0.0.1:${port}/api/vision/snapshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, t: 0, clipId: 'broken-clip' }), signal: AbortSignal.timeout(120000) });
  const result = await response.json();
  assert.ok(!response.ok, 'Invalid GLSL unexpectedly produced a successful frame');
  assert.match(result.error, /GLSL compilation failed/);
  assert.match(result.error, /missing_uniform/, 'Compiler symbol diagnostic was dropped by see_frames transport');
  assert.match(result.error, /undeclared|not declared/i, 'Compiler cause was dropped by see_frames transport');
  console.log('PASS actual see_frames compiler diagnostic', JSON.stringify({ status: response.status, error: result.error }));
} finally {
  await server.close();
  fs.rmSync(cardFile, { force: true });
}
