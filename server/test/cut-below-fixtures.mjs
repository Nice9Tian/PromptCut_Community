/**
 * Scenario for `cut-below-streams.test.mjs` (below-dependent cards in cut segments produce streams
 * with lower layers, [ruling] R01; online browser produces streams for heavy cards in cut segments,
 * [ruling] R02).
 * Standalone module: the same scenario is also used for the "top-level streams verbatim unchanged"
 * golden sample (golden sample was calculated with this scenario on kickoff commit `b362e254`).
 *
 * Test doubles for card definitions: whether it is below-dependent is checked against the review
 * table (`src/cards/capabilities.json`): `odometer` is "below-dependent", `caption-track` is
 * "standalone".
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
 * Top level (top to bottom):
 *   tt  over   standalone card 0-8           : above cut segment
 *   tg  topg   frosted glass (below-dependent) 0-8 : top-level below-dependent card (its lower
 *                                              layer contains cards flattened from cut segment)
 *   ts  S      cut segment → Cut B, 1-7 seconds, offset 1 second, box 960×540
 *   tv  vid    video 0-8                     : below cut segment (lower layer outside segment)
 * Cut B (top to bottom):
 *   b-up    up   standalone card 0-8         : in segment, above frosted glass
 *   b-glass g    frosted glass 0-8           : target card
 *   b-mid   m    standalone card 2-6         : lower layer in segment
 *   b-user  u    unregistered card (unknown) 0-8 : further below lower layer; treated as
 *                                              below-dependent, also outputs stream
 *   b-seg   S2   cut segment → Cut C, 0-8    : nested cut segment, at the very bottom
 * Cut C: c1  cc  standalone card 0-8
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
      { id: 'A', name: 'Main' },
      { id: 'B', name: 'In segment', duration: 8, transitions: [], tracks: [
        { id: 'b-up', clips: [card('up', 'caption-track', 0, 8, { params: { text: upText } })] },
        { id: 'b-glass', clips: [card('g', 'odometer', 0, 8, { params: { value: glassValue }, frame: { x: 100, y: 100, w: 600, h: 300 } })] },
        { id: 'b-mid', clips: [card('m', 'caption-track', 2, 6, { params: { text: midText } })] },
        { id: 'b-user', clips: [card('u', 'user-glass', 0, 8, { frame: { x: 700, y: 300, w: 400, h: 200 } })] },
        { id: 'b-seg', clips: [seg('S2', 'C', 0, 8)] },
      ] },
      { id: 'C', name: 'Inside', duration: 8, transitions: [], tracks: [
        { id: 'c1', clips: [card('cc', 'caption-track', 0, 8)] },
      ] },
    ],
  };
}

/** Top-level scenario without cut segments (same as `below-stream.test.mjs`): below-dependent card, standalone card, video */
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

/** Pass 1: real card graph (cut segments flattened, virtual clips patched with `flat`) → real card plan */
export function entryOf(p) {
  const flat = flatPlanProject(p);
  const graph = withFlatNodes(flat, projectCardGraph(flat, getCard));
  const cardPlan = new CardFrameCache({ root: UNUSED_ROOT, project: p, envFingerprint: FP }).plan({
    graph, sourceVersions: SOURCE_VERSIONS,
    environment: { width: p.width, height: p.height, fps: p.fps, theme: p.themeId, fontFingerprint: 'fonts-1' },
  });
  return { key: frameIdentity(p, 'code-1'), project: p, cardPlan };
}

/** Card plan inputs on page side (same as `pagePlanValue` in `browserNodeHost.ts`) */
export function pageValueOf(p) {
  const flat = flatPlanProject(p);
  return {
    graph: JSON.parse(JSON.stringify(withFlatNodes(flat, projectCardGraph(flat, getCard)))),
    sourceVersions: SOURCE_VERSIONS,
    environment: { width: p.width, height: p.height, fps: p.fps, theme: p.themeId, fontFingerprint: 'fonts-1' },
  };
}
