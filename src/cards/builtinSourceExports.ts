/**
 * Among the built-in modules the page carries itself, the few things that user card source often
 * imports from elsewhere to use as controls and defaults (C10 contract section 9 "Recognition",
 * [ruling] 2026-09-30).
 *
 * When the online page statically parses the source of synced user cards
 * (`src/kernel/cardSourceParse.mjs`) and meets a relative import of a built-in module (for example a
 * card moved over from `src/cards/native/` that writes
 * `import { hudControls, hudDefaults } from "../native/hud"`), it uses the value registered here,
 * which the page already has anyway, and does not execute the user source. The key is a
 * repository-relative path (compared with the candidate paths resolved from the relative import),
 * and the value is the export of this module that can be handed out:
 *   - Pure data (control tables, defaults) is handed over as is;
 *   - Pure functions are registered with `pureCall`, and when user source calls them with literal
 *     arguments (`assetOptions("lottie")`) they are evaluated by it.
 * Built-in modules not registered remain unrecognized (the panel's message says which case). Only
 * these few modules are registered, so as not to pull the whole `src/` into the online bundle; to
 * add one, add it here as usual.
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

/** The `builtins` for `parseCardSource` */
export function builtinSourceExports(key: string): Readonly<Record<string, unknown>> | null {
  return Object.prototype.hasOwnProperty.call(BUILTIN_SOURCE_EXPORTS, key) ? BUILTIN_SOURCE_EXPORTS[key] : null;
}
