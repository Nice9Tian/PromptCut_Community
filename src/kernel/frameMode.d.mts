export type FrameMode = 'direct' | 'stateful';
/** @deprecated Old card source remains readable; new cards use FrameMode. */
export type LegacyFrameMode = 'react' | 'non-react';
export type FrameModeInput = FrameMode | LegacyFrameMode;
/** `context` is the legacy umbrella term for sourceDependent / belowDependent, preserved only for reading old .proc files. */
export type CardCompositing = 'independent' | 'sourceDependent' | 'belowDependent' | 'context' | 'unknown';
/** Card entry in review table (src/cards/capabilities.json): three registrations (see src/cards/capabilities.md).
 * Table omits frameMode (uses card declaration only) and canvasHeavy (derived from surface, see reviewedCanvas). */
export interface ReviewedCard { writing?: 'remotion' | 'motion'; surface?: 'dom' | 'canvas2d' | 'webgl' | 'none'; compositing?: 'independent' | 'sourceDependent' | 'belowDependent' | 'unknown' | 'fromParts' }
export type PartSource = string | { from?: string; cardId?: string };
type Definition = { id?: string; frameMode?: FrameModeInput; need_prerendering?: boolean; compositing?: CardCompositing; canvasHeavy?: boolean; defaults?: any; lifecycle?: any; timing?: (params: any) => any };
export const COMPOSITING_VALUES: CardCompositing[];
export const DERIVED_FROM_PARTS: string[];
export function normalizeFrameMode(mode: unknown): FrameMode | undefined;
export function cardFrameMode(def?: Definition, params?: any): FrameMode;
export function reviewedCard(id?: string): ReviewedCard | undefined;
/** Whether review table marks card as canvas card (surface: canvas2d / webgl); undefined if absent or surface unlisted */
export function reviewedCanvas(id?: string): boolean | undefined;
export function derivedCompositing(parts?: PartSource[]): CardCompositing;
export function degradeCard(id?: string, reason?: string): boolean;
export function degradedCards(): Map<string, string>;
export function resetDegradedCards(): void;
export function cardCapabilities(def?: Definition, params?: any, parts?: PartSource[]): { frameMode: FrameMode; need_prerendering: boolean; compositing: CardCompositing; canvasHeavy: boolean; independentCache: boolean };
export function clipFrameMode(clip: { parts?: unknown[]; params?: any }, def?: Definition): FrameMode;
