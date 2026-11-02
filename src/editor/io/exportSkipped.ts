import { tr } from "../../i18n/index.ts";
/**
 * How to tell the user about clips skipped during export because media is missing (`dropSkippedMediaClips` in `server/vite-plugin-export.ts`:
 * with no hash and an empty address (old media that this machine cannot fetch after opening the project, already marked "(missing)"), the clips they belong to are left out of this export).
 * Not silent: the export-complete dialog lists this media (worded like `packMissingMessage` of pack-and-save). This module imports no other module, so Node unit tests can import it directly.
 */

export interface ExportSkipped {
  id: string;
  name: string;
  /** Number of clips of this media removed in this export */
  clips?: number;
}

const MISSING_PREFIX = tr("(missing) ");

/** Normalize `skippedMedia` in the response into an array; drop invalid entries */
export function parseExportSkipped(raw: unknown): ExportSkipped[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ id: String(x.id ?? ""), name: String(x.name ?? ""), ...(typeof x.clips === "number" ? { clips: x.clips } : {}) }))
    .filter((x) => x.id || x.name);
}

/** The message shown to the user when export completes: which media were skipped because they are missing (names deduplicated, the "(missing) " marker removed, only the first several listed if there are too many); an empty string if none */
export function exportSkippedMessage(skipped: readonly ExportSkipped[], limit = 12): string {
// i18n-allow: names in older projects carry the Chinese marker
  const names = [...new Set(skipped.map((m) => (m.name || m.id).replace(/^\((?:missing|缺失)\) /, "")))];
  if (!names.length) return "";
  const shown = names.slice(0, limit).map((n) => `· ${n}`).join("\n");
  const more = names.length > limit ? tr("\n…and {0} more", names.length - limit) : "";
  return tr("The following {0} media files were not found on this machine (marked \"{1}\" in the media library). Export skipped the clips they belong to; the rest of the picture and sound is unchanged:\n{2}{3}", names.length, MISSING_PREFIX.trim(), shown, more);
}
