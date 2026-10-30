import type { Control } from "./types";

/** 被跳过的控件:认得出的 key / label / type 与原因(参数面板说明是哪一条) */
export interface SkippedControl {
  key?: string;
  label?: string;
  type?: string;
  reason: string;
}

/** 源码里认出的一张卡(`defaults` / `controls` / `description` 只认字面量,见 `cardSourceParse.mjs` 文件头) */
export interface ParsedCardSource {
  embeddedAudio?: boolean;
  id: string;
  name: string;
  description?: string;
  defaults: Record<string, unknown>;
  controls: Control[];
  /** 有控件没认出来(或整个 `controls` 不是字面量) */
  controlsIncomplete: boolean;
  /** 被跳过的控件,逐条 */
  skippedControls: SkippedControl[];
}

export interface ParseCardSourceOptions {
  /** 这份源码的仓库相对路径(`src/cards/user/x.tsx`),相对导入按它解析 */
  key?: string;
  /** 别的文件的源码(内容库里同步来的 `card-source`);没有回 null / undefined */
  files?: (key: string) => string | null | undefined;
  /** 页面自己带着的内置模块的导出(纯数据,或 `pureCall` 登记的纯函数);没有回 null / undefined */
  builtins?: (key: string) => Record<string, unknown> | null | undefined;
}

/** 一份卡片源码里定义的卡(不执行源码);认不出回空数组 */
export function parseCardSource(source: string, opts?: ParseCardSourceOptions): ParsedCardSource[];
/** 一个已求值的控件对象 → `Control`;画不出来的回 null */
export function controlOf(v: unknown): Control | null;
/** 一个已求值的控件对象 → `{ control }`,或画不出来的原因 `{ reason }`(能推断的补上) */
export function controlFix(v: unknown, opts?: { dropped?: string[]; defaultValue?: unknown }): { control?: Control; reason?: string };
/** 内容库里的卡片源码键是不是一张用户卡的入口文件(`src/cards/user/<名>.tsx`) */
export function isUserCardEntryKey(key: unknown): boolean;
/** 相对导入 → 候选的仓库相对路径;不是相对路径回 null */
export function resolveSpecifier(fromKey: string, spec: string): string[] | null;
/** 源码里 `import … from` / `export … from` 的说明符 */
export function importSpecifiers(source: string): string[];
/** 源码经相对导入可能引到的仓库相对路径(全部候选) */
export function cardSourceImports(source: string, key: string): string[];
/** 纯函数标记 */
export const PURE_CALL: unique symbol;
/** 把页面自己的纯函数登记进内置模块表(以字面量为参数调用时求值) */
export function pureCall<A extends unknown[], R>(fn: (...args: A) => R): Readonly<Record<symbol, (...args: A) => R>>;
