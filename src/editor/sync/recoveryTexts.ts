import { tr } from "../../i18n/index.ts";
/**
 * The text shown to users for two cases, opening an old cloud project file and missing media, is gathered in this one place.
 *
 * These are all UI texts (first-level semantics); the task brief `docs/plan/account-binding-task.md` has no verbatim wording,
 * so the current wording is a draft, and once the user finalizes it only this one file needs changing (drafts and sources are listed in `docs/reports/AGENT-v18-missing.md` "Things the user must decide").
 * The "Cannot find media xxx" on the canvas placeholder is the task brief's original wording, in `src/render/MissingMaterial.tsx`, not here.
 */
export const CLOUD_GONE_TEXT = {
  /** Window for the one-time notice after converting to a local project */
  title: tr("Cloud project no longer exists"),
  body: tr("The cloud project for this file has been deleted from the cloud. The content saved in the file was converted into a local project and multi-user collaboration is turned off; you can turn it back on in project settings if needed."),
  keep: tr("The original file is unchanged; saving will save it as a new file."),
  ok: tr("Got it"),
  /** Collaboration status bar: the service explicitly answered that this project does not exist, but no "deleted" proof could be obtained */
  missingUnconfirmed: tr("The cloud could not find this project and cannot confirm it was deleted; local content has been kept and was not converted to a local project."),
  /** Collaboration status bar: the returned "deleted" proof failed verification */
  proofRejected: tr("The deletion proof returned by the cloud failed verification, possibly because it connected to a different service; local content has been kept and was not converted to a local project."),
} as const;

export const UNSUPPORTED_PROC_TEXT = (version: unknown) =>
  tr("This project file was saved by a newer version of PromptCut (format version {0}) and cannot be opened by this version; the original file was not changed.", String(version));

export const MISSING_MATERIALS_TEXT = {
  title: tr("Media not found"),
  missing: (n: number) => tr("The files for the {0} media items below could not be found on this computer. The positions and arrangement of the clips that use them are kept; the picture shows \"Media not found\" and the file name, and the audio plays a \"Media not found\" prompt tone once. Import the files back and they will be restored automatically.", n),
  changed: tr("The file at the original location has changed"),
  ok: tr("Got it"),
} as const;
