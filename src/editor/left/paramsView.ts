/**
 * 参数面板与时间轴副标题看的「这张卡的参数长什么样」(纯函数,单测直接载入)。
 *
 * 先查注册表里能跑的定义(`getCard`);查不到时,在线页面从内容库同步来的用户卡还有一份只读视图(`syncedCardView`,
 * 从源码静态解析出的名字、说明、默认值与控件,没有组件;C10 契约第 9 节「片段照常可以改参数」)。两边都没有回 undefined。
 */
import type { CardDef, Control } from "../../kernel/types";
import type { SkippedControl, SyncedCardView } from "../../kernel/registry";
import { onlineUnsupported } from "../../online/pageFlag";

/** 面板要的那几样:能跑的定义与同步来的视图都满足 */
export interface ParamsCardView {
  name: string;
  description?: string;
  defaults: Record<string, unknown>;
  controls: Control[];
  /** 只有同步视图有:源码里有控件没认出来 */
  controlsIncomplete?: boolean;
  /** 只有同步视图有:没认出来的控件逐条 */
  skippedControls?: SkippedControl[];
}

export function paramsCardView(
  cardId: string | undefined | null,
  lookup: { getCard: (id: string) => CardDef<any> | undefined; syncedCardView: (id: string) => SyncedCardView | undefined },
): ParamsCardView | undefined {
  if (typeof cardId !== "string" || !cardId) return undefined;
  return lookup.getCard(cardId) ?? lookup.syncedCardView(cardId);
}

/** 没有控件可画时的那句话 */
export const NO_PARAMS_TEXT = "这张卡没有可调参数";
/** 源码里有控件、在线一个都认不出来时用的入口名(`onlineUnsupported` 那句的中间) */
export const ONLINE_PARAMS_ENTRY = "修改这张卡的参数";

/**
 * 参数面板画不出控件时显示什么;有控件可画回 null。同步来的卡源码里写了控件、却一个都没解析出来时,
 * 说明「在线浏览器模式暂不支持修改这张卡的参数…」,不说「没有可调参数」(它其实有)。
 */
export function paramsEmptyText(view: ParamsCardView | undefined): string | null {
  if (view && Array.isArray(view.controls) && view.controls.length > 0) return null;
  if (view?.controlsIncomplete) return onlineUnsupported(ONLINE_PARAMS_ENTRY);
  return NO_PARAMS_TEXT;
}

/** 源码里的控件只认出一部分时,面板在认出的控件下面加的那一行用的入口名 */
export const ONLINE_PARAMS_REST_ENTRY = "修改这张卡的其余参数";

/**
 * 同步来的卡控件只认出一部分(比如展开了从别的文件引进来的控件):照常画认出的那些,下面加一行提示;
 * 其余情形(全认出、一个都没认出、能跑的定义)回 null。
 */
export function paramsPartialText(view: ParamsCardView | undefined): string | null {
  if (!view?.controlsIncomplete || !Array.isArray(view.controls) || view.controls.length === 0) return null;
  return onlineUnsupported(ONLINE_PARAMS_REST_ENTRY);
}

/** 面板上最多逐条列几个没认出的控件(其余的说「等 N 条」) */
export const SKIPPED_LIST_MAX = 5;

/** 一个没认出的控件在面板上怎么称呼:「标签」(key),没有就用 key,再没有就说「一个控件」 */
function skippedName(s: SkippedControl): string {
  if (s.label && s.key) return `「${s.label}」(${s.key})`;
  if (s.label) return `「${s.label}」`;
  if (s.key) return s.key;
  return "一个控件";
}

/**
 * 同步来的卡有控件没认出来时,在「在线浏览器模式暂不支持修改…」那句下面说明是哪几条、为什么(C10 契约第 9 节〔裁〕2026-09-30);
 * 没有逐条记录(旧页面、能跑的定义)回 null。
 */
export function paramsSkippedText(view: ParamsCardView | undefined): string | null {
  const list = view?.controlsIncomplete && Array.isArray(view.skippedControls) ? view.skippedControls : [];
  if (!list.length) return null;
  const shown = list.slice(0, SKIPPED_LIST_MAX).map((s) => `${skippedName(s)}:${s.reason}`);
  const more = list.length > SKIPPED_LIST_MAX ? `;等 ${list.length} 条` : "";
  return `没认出的参数:${shown.join(";")}${more}`;
}

/** 时间轴副标题:第一个文字控件的当前值 → 卡片说明 → 空 */
export function clipSubtitleOf(view: ParamsCardView | undefined, params: Record<string, unknown> | undefined): string {
  if (!view) return "";
  const textControl = (view.controls ?? []).find((c) => c.type === "text");
  let subtitle = "";
  if (textControl) {
    const val = params?.[textControl.key] ?? view.defaults?.[textControl.key];
    subtitle = val != null ? String(val).trim() : "";
  }
  return subtitle || view.description || "";
}
