/**
 * 页面自己带着的内置模块里,用户卡源码常从别处引进来当控件、默认值用的那几样(C10 契约第 9 节「识别」〔裁〕2026-09-30)。
 *
 * 在线页面静态解析同步来的用户卡源码(`src/kernel/cardSourceParse.mjs`)时,遇到相对导入到内置模块(例如从
 * `src/cards/native/` 搬来的卡写着 `import { hudControls, hudDefaults } from "../native/hud"`),就用这里登记的、页面里本来就有的
 * 那份值,不执行用户源码。键是仓库相对路径(与相对导入解析出的候选路径比对),值是这个模块里可以交出去的导出:
 *   - 纯数据(控件表、默认值)原样交;
 *   - 纯函数用 `pureCall` 登记,用户源码里以字面量为参数调用时(`assetOptions("lottie")`)按它求值。
 * 没登记的内置模块照旧认不出(面板说明是哪一条)。只登记这几个模块,免得把整个 `src/` 拉进在线包;要加照样往这里加。
 */
import { hudControls, hudDefaults, hudOffsetControls, hudOffsetDefaults } from "./native/hud";
import { assetOptions, type AssetKind } from "./catalogAssets";
import { NOTIFICATION_SOUND_DEFAULTS, KEYBOARD_SOUND_DEFAULTS } from "../kernel/soundEffects";
import { pureCall } from "../kernel/cardSourceParse.mjs";

export const BUILTIN_SOURCE_EXPORTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  "src/kernel/soundEffects.ts": Object.freeze({ NOTIFICATION_SOUND_DEFAULTS, KEYBOARD_SOUND_DEFAULTS }),
  "src/cards/native/hud.ts": Object.freeze({ hudControls, hudDefaults, hudOffsetControls, hudOffsetDefaults }),
  "src/cards/catalogAssets.ts": Object.freeze({
    assetOptions: pureCall((kind: unknown) => (kind === "lottie" || kind === "particles" ? assetOptions(kind as AssetKind) : null)),
  }),
});

/** 给 `parseCardSource` 的 `builtins` */
export function builtinSourceExports(key: string): Readonly<Record<string, unknown>> | null {
  return Object.prototype.hasOwnProperty.call(BUILTIN_SOURCE_EXPORTS, key) ? BUILTIN_SOURCE_EXPORTS[key] : null;
}
