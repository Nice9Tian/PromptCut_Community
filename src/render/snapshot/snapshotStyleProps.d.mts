/** 差异样式内联的属性表(底稿 A2(8))。说明见 snapshotStyleProps.mjs。 */
export const INHERITED_PROPS: Set<string>;
export const LAYOUT_USED_VALUE_PROPS: Set<string>;
export const LAYOUT_UNIT_PROPS: Set<string>;
export function snapLayoutUnits(value: string): string;
/** Typed OM 的计算变换按分量写回(函数形式、全精度);认不出来返回 null */
export function serializeTransformList(list: Iterable<unknown>): string | null;
export const COMPOSITED_ANIMATION_PROPS: Set<string>;
type AnimationTiming = {
  localTime?: CSSNumberish | null; endTime?: CSSNumberish; delay?: number; activeDuration?: CSSNumberish; progress?: number | null;
};
/** relevant = current 或 in effect:Blink 给动画提合成层的判据 */
export function isRelevantAnimation(timing: AnimationTiming, playbackRate: number, playState: AnimationPlayState): boolean;
export function isCurrentAnimation(timing: AnimationTiming, playbackRate: number, playState: AnimationPlayState): boolean;
export function isInheritedProp(prop: string): boolean;
