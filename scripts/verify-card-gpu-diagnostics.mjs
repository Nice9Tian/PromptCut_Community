/**
 * 真实的浏览器 + vision HTTP 错误传输，不是打桩的 shader。
 *
 * 测的是「GLSL 编译诊断经 frameReady → see_frames 原样传出来」。素材效果卡走的是和从前
 * Python 卡同一条路（`CardGpuExecutor` 在 WebGL 上编译），所以断言一个字没改。
 *
 * 仓库里没有「注册」函数，素材效果卡只能是文件：脚本先把这张故意写错 uniform 的素材效果卡写成
 * 临时文件 `src/cards/user/__probe-broken-shader.tsx`（**写在 createServer 之前**，
 * 别和 vite 的文件发现抢时间），再用 `server.ssrLoadModule` 把它加载进来当 `getCard`
 * 传给 `applyCardDefinition`（裸 Node `import('*.tsx')` 会 ERR_UNKNOWN_FILE_EXTENSION，
 * `scripts/` 没有 TS loader）。跑完删掉。
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

/** 验证脚本的临时卡:故意引用一个没有声明的 uniform,用来看编译诊断有没有原样传出来。 */
export const brokenShader: CardDef<Record<string, never>> = {
  id: "${CARD_ID}",
  name: "编译诊断探针",
  description: "故意写错 uniform 的 GLSL 素材效果卡,只给 verify-card-gpu-diagnostics 用",
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
// 端口可以用 PC_VERIFY_PORT 换掉:同一台机器上并行跑几个验证脚本时别互相抢
const port = Number(process.env.PC_VERIFY_PORT) || 5199;
const server = await createServer({ configFile: 'vite.prerender.config.ts', server: { host: '127.0.0.1', port, strictPort: true } });
try {
  await server.listen();
  const mod = await server.ssrLoadModule(`/src/cards/user/${CARD_ID}.tsx`);
  // ssrLoadModule 回的是模块命名空间,不是函数 —— 取出里面那个 CardDef 再包成 getCard
  const definition = Object.values(mod).find((value) => value && typeof value === 'object' && value.id === CARD_ID);
  assert.ok(definition, `临时素材效果卡没有导出 id 为 ${CARD_ID} 的 CardDef`);
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
