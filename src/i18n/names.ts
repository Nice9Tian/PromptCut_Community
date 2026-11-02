import { tr } from "./index.ts";

/**
 * Names stored in a project are data. Default names (the first cut, new tracks) were written in
 * Chinese by older versions and still are by the kernel, and card names come from card code, so
 * the interface shows them in its own language. A name someone typed is shown as typed, unless it
 * happens to be one of the labels in the translation table.
 */
// i18n-allow: matches default names that older projects and the kernel store in Chinese
const CUT = /^(?:剪辑|Cut)\s*(\d+)$/;
// i18n-allow: matches default names that older projects and the kernel store in Chinese
const TRACK = /^(?:序列|Track)\s*(\d+)$/;

export function shownName(name: string): string {
  const s = name.trim();
  const cut = CUT.exec(s);
  if (cut) return tr("Cut {0}", cut[1]);
  const track = TRACK.exec(s);
  if (track) return tr("Track {0}", track[1]);
  return tr(s);
}

/** For lookups that may find nothing */
export function shownNameOf(name: string | null | undefined): string | undefined {
  return name ? shownName(name) : undefined;
}
