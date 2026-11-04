import { tr } from "../i18n/index.ts";

/**
 * Hover explanation for disabled entries in online browser mode (C10 contract section 10, section 17 table A):
 * "{entryName} is not yet supported in online browser mode. Please use PromptCut on desktop."
 * Entry names use UI labels seen by users ("Import media", "Speech-to-text", "Voiceover"…).
 * Placed in a separate file: audio Worker imports `pageFlag.ts`, cannot load translation table into Worker.
 */
export function onlineUnsupported(entry: string): string {
  return tr("{0} is not supported in online browser mode yet. Please use it in PromptCut on your computer.", entry);
}
