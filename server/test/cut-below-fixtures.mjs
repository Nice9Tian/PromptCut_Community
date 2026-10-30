/**
 * `cut-below-streams.test.mjs` 的场景(剪辑段里依赖下层的卡带着下层产流,〔裁〕R01;在线浏览器替剪辑段里的重卡产流,〔裁〕R02)。
 * 单独一个模块:同一份场景也给「顶层的流一个字不变」的金样用(金样是在开工提交 `b362e254` 上用这份场景算出来的)。
 *
 * 卡片定义的替身:依不依赖下层这一样看审阅表(`src/cards/capabilities.json`):`odometer` 是「依赖下层」,`caption-track` 是「独立」。
 */
import os from 'node:os';
import path from 'node:path';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { flatPlanProject, withFlatNodes } from '../../src/kernel/cutFlatten.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { frameIdentity } from '../frame-identity.mjs';

export const FP = '0123456789abcdef';
export const CV = 'cv-cut-below';
const UNUSED_ROOT = path.join(os.tmpdir(), 'pc-cut-below-unused');

export const DEFS = {
  odometer: { id: 'odometer', frameMode: 'stateful', defaults: {} },
  'caption-track': { id: 'caption-track', frameMode: 'stateful', defaults: {} },
  'user-glass': { id: 'user-glass', frameMode: 'stateful', defaults: {} },
};
export const getCard = id => DEFS[id];
export const SOURCE_VERSIONS = Object.fromEntries(Object.keys(DEFS).map(id => [id, `builtin:${id}-v1`]));

const card = (id, cardId, start, end, extra = {}) => ({ id, cardId, start, end, params: { text: id }, ...extra });
const seg = (id, cutId, start, end, extra = {}) => ({ id, cardId: '', cutId, start, end, params: {}, ...extra });

/**
 * 顶层(从上到下):
 *   tt  over   独立卡 0～8                 —— 在剪辑段上面
 *   tg  topg   毛玻璃(依赖下层)0～8         —— 顶层的依赖下层的卡(它的下层里有剪辑段里摊出来的卡)
 *   ts  S      剪辑段 → 剪辑 B,1～7 秒,偏移 1 秒,框 960×540
 *   tv  vid    视频 0～8                   —— 剪辑段下面(段外的下层)
 * 剪辑 B(从上到下):
 *   b-up    up   独立卡 0～8              —— 段里、在毛玻璃上面
 *   b-glass g    毛玻璃 0～8              —— 目标卡
 *   b-mid   m    独立卡 2～6              —— 段里的下层
 *   b-user  u    没登记的卡(未知)0～8      —— 在下层再下面;按依赖下层算,也出流
 *   b-seg   S2   剪辑段 → 剪辑 C,0～8     —— 嵌套剪辑段,在最下面
 * 剪辑 C:c1  cc  独立卡 0～8
 */
export function cutProject({ glassValue = 42, midText = 'm', upText = 'up', segFrame = { x: 160, y: 90, w: 960, h: 540 }, outerText = 'over', segOpacity, extraOuter = false } = {}) {
  return {
    id: 'cut-below-p', name: 'p', width: 1280, height: 720, fps: 30, duration: 8, themeId: 'dark', style: {},
    media: [{ id: 'm1', kind: 'video', hash: 'h1', url: '/@media/h1' }],
    filters: [], pixelMaps: [], audioFx: [], cardNodes: [], activeCutId: 'A',
    tracks: [
      { id: 'tt', clips: [card('over', 'caption-track', 0, 8, { params: { text: outerText } })] },
      { id: 'tg', clips: [card('topg', 'odometer', 0, 8, { params: { value: 7 }, frame: { x: 0, y: 0, w: 400, h: 200 } })] },
      { id: 'ts', clips: [seg('S', 'B', 1, 7, { cutOffset: 1, frame: { ...segFrame }, ...(segOpacity !== undefined ? { opacity: segOpacity } : {}) })] },
      ...(extraOuter ? [{ id: 'tx', clips: [card('extra', 'caption-track', 0, 8)] }] : []),
      { id: 'tv', clips: [{ id: 'vid', mediaId: 'm1', start: 0, end: 8, mediaOffset: 0, params: {} }] },
    ],
    cuts: [
      { id: 'A', name: '主' },
      { id: 'B', name: '段里', duration: 8, transitions: [], tracks: [
        { id: 'b-up', clips: [card('up', 'caption-track', 0, 8, { params: { text: upText } })] },
        { id: 'b-glass', clips: [card('g', 'odometer', 0, 8, { params: { value: glassValue }, frame: { x: 100, y: 100, w: 600, h: 300 } })] },
        { id: 'b-mid', clips: [card('m', 'caption-track', 2, 6, { params: { text: midText } })] },
        { id: 'b-user', clips: [card('u', 'user-glass', 0, 8, { frame: { x: 700, y: 300, w: 400, h: 200 } })] },
        { id: 'b-seg', clips: [seg('S2', 'C', 0, 8)] },
      ] },
      { id: 'C', name: '里面', duration: 8, transitions: [], tracks: [
        { id: 'c1', clips: [card('cc', 'caption-track', 0, 8)] },
      ] },
    ],
  };
}

/** 不带剪辑段的顶层场景(同 `below-stream.test.mjs` 的那一份):依赖下层的卡、独立卡、视频 */
export function topProject() {
  return {
    id: 'below-p', width: 1280, height: 720, fps: 30, duration: 8, themeId: 'dark', style: {},
    media: [{ id: 'm1', kind: 'video', hash: 'h1', url: '/@media/h1' }],
    filters: [], pixelMaps: [], cardNodes: [],
    tracks: [
      { id: 't-top', clips: [{ id: 'top', cardId: 'caption-track', start: 0, end: 6, params: { text: 'top' } }] },
      { id: 't-glass', clips: [{ id: 'glass', cardId: 'odometer', start: 1, end: 4, params: { value: 42 }, frame: { x: 100, y: 100, w: 600, h: 300 }, opacity: 1 }] },
      { id: 't-mid', clips: [{ id: 'mid', cardId: 'caption-track', start: 0, end: 5, params: { text: 'mid' } }] },
      { id: 't-user', clips: [{ id: 'ug', cardId: 'user-glass', start: 2, end: 7, params: {} }] },
      { id: 't-low', clips: [{ id: 'vid', mediaId: 'm1', start: 0, end: 8, mediaOffset: 0, params: {} }] },
    ],
  };
}

/** 一版:真的卡片图(剪辑段摊平、虚拟片段补 `flat`)→ 真的卡片计划 */
export function entryOf(p) {
  const flat = flatPlanProject(p);
  const graph = withFlatNodes(flat, projectCardGraph(flat, getCard));
  const cardPlan = new CardFrameCache({ root: UNUSED_ROOT, project: p, envFingerprint: FP }).plan({
    graph, sourceVersions: SOURCE_VERSIONS,
    environment: { width: p.width, height: p.height, fps: p.fps, theme: p.themeId, fontFingerprint: 'fonts-1' },
  });
  return { key: frameIdentity(p, 'code-1'), project: p, cardPlan };
}

/** 页面一侧的卡片计划原料(同 `browserNodeHost.ts` 的 `pagePlanValue`) */
export function pageValueOf(p) {
  const flat = flatPlanProject(p);
  return {
    graph: JSON.parse(JSON.stringify(withFlatNodes(flat, projectCardGraph(flat, getCard)))),
    sourceVersions: SOURCE_VERSIONS,
    environment: { width: p.width, height: p.height, fps: p.fps, theme: p.themeId, fontFingerprint: 'fonts-1' },
  };
}
