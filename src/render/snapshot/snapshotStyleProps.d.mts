/** Property table for diff style inlining (draft A2(8)). See snapshotStyleProps.mjs for details. */
export const INHERITED_PROPS: Set<string>;
export const LAYOUT_USED_VALUE_PROPS: Set<string>;
export const LAYOUT_UNIT_PROPS: Set<string>;
export function snapLayoutUnits(value: string): string;
/**
 * Writes back Typed OM computed transforms by component (functional form, full precision);
 * returns null if unrecognized
 */
export function serializeTransformList(list: Iterable<unknown>): string | null;
export const COMPOSITED_ANIMATION_PROPS: Set<string>;
type AnimationTiming = {
  localTime?: CSSNumberish | null; endTime?: CSSNumberish; delay?: number; activeDuration?: CSSNumberish; progress?: number | null;
};
/**
 * relevant = current or in effect: Blink's criterion for promoting animations to a
 * composited layer
 */
export function isRelevantAnimation(timing: AnimationTiming, playbackRate: number, playState: AnimationPlayState): boolean;
export function isCurrentAnimation(timing: AnimationTiming, playbackRate: number, playState: AnimationPlayState): boolean;
export function isInheritedProp(prop: string): boolean;
