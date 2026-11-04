import { snapshotsFor, restoreSnapshots, frameRequest } from "../../render/frameClient";
import { actions, getState } from "../../store/project";
import { createEmptyProject, newProjectId } from "../../kernel/project";
import type { Project } from "../../kernel/project";
import { exportProjectJson } from "./index";
import { bundledCardsOf, collectProjectCards, restoreProjectCards, type BundledCard } from "./procCards";
import { restoreMediaUrls } from "./mediaUrls";
import { dropPythonNodes, publishPythonDrop } from "./pythonDrop";
import { collectProjectAi, applyProjectAi, resetProjectAi, type ProjectAi } from "../../ai/projectAi";
import { getSkillSnapshot } from "../../skill/skillMode";
import { checkAssociation, convertedFromOf, currentAssociation, noteConvertedFrom, noteLoadedAssociation, onGoneConversion, type CollaborationDescriptor, type ConvertedFrom, type CloudProjectAssociation, currentCloudAssociation, noteLoadedCloudAssociation, currentCloudSnapshot } from "../sync/recoveryAssociation";
import { snapshotForSave } from "../sync/cloudSnapshot";
import { UNSUPPORTED_PROC_TEXT } from "../sync/recoveryTexts";
import { writeToHandle } from "./safeWrite";
import { tr } from "../../i18n/index.ts";

export { writeToHandle } from "./safeWrite";

/**
 * On save, stamp the project with a mark saying "this is a product of SKILL mode". Outside SKILL mode this section is not written.
 */
/** Compile-time constant of the online build (for how to write it and why, see "Online build pruning" in `src/online/pageFlag.ts`): online pages have no SKILL mode, so no stamp */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

function skillStamp(): { active: boolean; at?: string } | undefined {
  if (ONLINE_BUILD) return undefined;
  const { state } = getSkillSnapshot();
  if (!state.active) return undefined;
  return { active: true, at: new Date().toISOString() };
}

/**
 * `.proc`: PromptCut's own project file.
 *
 * It is just a thin shell plus an arrangement: the shell records the format and version, so old files
 * can still be recognized when the structure changes later. It reads the old `.promptcut.json` for
 * compatibility (back then it was a bare Project), so `parseProc` accepts both.
 *
 * Media itself does not go into .proc; only the asset key and the server-side path are recorded: an
 * arrangement is a few dozen KB, and stuffing videos into it would make it impossible to send to others.
 * The asset key is the sha256 of the file content (`media[i].hash`, A1); on read-back, parseProc uses it
 * to turn the address back into /@media/<hash>; only old files without a hash fall back to looking up
 * by the file name of the path (see mediaUrls.ts).
 * To take the media along, use .procp (zip: the first entry is this project.proc, the rest are
 * media/<hash>.<ext>, see procp.ts); the top bar's "Pack and save..." takes that route.
 *
 * One invariant: **clip.params read back must be preserved as is; defaults are never filled in here.**
 * clip.params is now materialized at write time (the store's addCardClip / setClipCard expands the
 * defaults in full and stores them into the clip), so what the file holds is the complete set of true
 * values; merging defaults once more here would only silently overwrite values the user changed.
 * The {...defaults, ...params} layer in Stage is only a fallback for "the card later gained a new
 * parameter and an old clip lacks that key"; it is not this code's job.
 * Verified: both the in-memory round trip and the through-disk round trip give byte-identical params.
 */

export const PROC_EXT = ".proc";
export const PROC_FORMAT = "promptcut-project";
export const PROC_VERSION = 1;

export interface ProcFile {
  format: typeof PROC_FORMAT;
  version: number;
  savedAt: string;
  /** Cover shown in lists, left to be filled in later; always null for now */
  thumbnail: string | null;
  project: Project;
  /**
   * The script and this AI chat. A sibling of project rather than stuffed inside project:
   * project is returned as is to the model by get_project, and putting the chat log in it would make
   * the model re-read everything it said before on every call. Old files do not have this section;
   * it is treated as empty on read.
   */
  ai?: ProjectAi;
  /**
   * Whether this arrangement was saved under SKILL mode. `jobId` was written by an old version (the task
   * number of a headless instance, archived); it can be read in but is no longer written.
   *
   * It is only a **trace left in the project file**, not a runtime switch: what really decides "whether
   * operations are allowed right now" is the state file in server/skill-gate.mjs. Reason: the Rust shell
   * and the editor are two processes, and a .proc can be saved elsewhere or copied away at any time;
   * using a file that can run as shared state would sooner or later leave the two sides seeing
   * different modes. It is recorded here so that afterwards you can tell "who changed this part".
   */
  skill?: { active: boolean; jobId?: string | null; at?: string };
  /**
   * Source code of the custom cards this project uses (the kind the Agent writes with create_card).
   *
   * Media does not go into .proc, but card code must: media is the user's own files and still sits where
   * it was; custom cards live in this machine's global directory src/cards/user/, so if the .proc is
   * copied away, moved to another machine, or a same-named card from another project overwrites it, the
   * video is left with a cardId it cannot find. On open they are reinstalled onto this machine; see
   * procCards.ts for the rules. If there are no custom cards, this section is not written.
   */
  cards?: BundledCard[];
  /** Disposable frame deltas, encoded as one gzip/base64 block. */
  snapshots?: string;
  /** Stable room association only. Authentication stays on each device. */
  collaboration?: CollaborationDescriptor;
  /** Which cloud project, which no longer exists, this local project was converted from (only for hints and traceability, not a collaboration link; see `recoveryAssociation.ts`) */
  convertedFrom?: ConvertedFrom;
  /** Cloud association marker used when an account's cloud project is saved as a file (10-14 section 3.4) */
  cloudAssociation?: CloudProjectAssociation;
}

/** Current project → .proc text */
export function serializeProc(thumbnail: string | null = null): string {
  const project = JSON.parse(exportProjectJson()) as Project;
  const cards = collectProjectCards(project);
  const currentAssoc = currentCloudAssociation();
  // Pinned non-local snapshot (`sync/cloudSnapshot.ts`): when connected to this cloud project, record the version
  // confirmed at this moment (baseline content + hash + sequence number + time); when not connected (opened as a
  // local copy, offline), keep the baseline and sequence number already in the file. Do not take "the current
  // connection's sequence number" anymore: when opened as a local copy, that is the sequence number of the local space
  const cloudAssoc: CloudProjectAssociation | undefined = currentAssoc
    ? { ...currentAssoc, ...snapshotForSave(currentAssoc, currentCloudSnapshot(currentAssoc.projectId)) }
    : undefined;
  const doc: ProcFile = {
    format: PROC_FORMAT,
    version: PROC_VERSION,
    savedAt: new Date().toISOString(),
    thumbnail,
    snapshots: snapshotsFor(getState().project),
    project,
    ai: collectProjectAi(),
    skill: skillStamp(),
    cards: cards.length ? cards : undefined,
    collaboration: currentAssociation() ?? undefined,
    convertedFrom: convertedFromOf(project) ?? undefined,
    cloudAssociation: cloudAssoc,
  };
  return JSON.stringify(doc, null, 2);
}

/** Time limit for collecting prerender snapshots (milliseconds) */
export const FRAME_ARCHIVE_TIMEOUT_MS = 2500;

/**
 * Collect the prerender snapshots the render side has already finished into the `.proc` text (before saving,
 * wait for this machine's "render" to finish writing, `docs/semantics/mechanism/document-service.md`
 * "Save baseline and modification state check"). Snapshots are a disposable cache: if missing or broken
 * they must not block saving, so when none can be collected, save the original text as is;
 * but if the **time limit is reached without collecting them** (`timedOut`), tell the user that this
 * file carries no snapshots, rather than letting it pass silently.
 */
export async function collectFrameSnapshots(text: string): Promise<{ text: string; timedOut: boolean }> {
  let doc: ProcFile;
  try {
    doc = JSON.parse(text) as ProcFile;
  } catch { return { text, timedOut: false }; }
  if (doc?.format !== PROC_FORMAT) return { text, timedOut: false };
  // Judge the time limit from the signal itself: frameRequest wraps errors in another layer (the name is lost), and the step before the request that aligns the data mirror does not honor the signal either, so race against the time limit once more
  const signal = AbortSignal.timeout(FRAME_ARCHIVE_TIMEOUT_MS);
  const timeUp = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  try {
    const result = await Promise.race([frameRequest("archive", doc.project, {}, signal), timeUp]);
    doc.snapshots = result.snapshots;
    return { text: JSON.stringify(doc, null, 2), timedOut: false };
  } catch {
    return { text, timedOut: signal.aborted };
  }
}

/** Collect whatever B has completed. Missing/corrupt caches must never prevent saving the project. */
export async function withFrameSnapshots(text: string): Promise<string> {
  return (await collectFrameSnapshots(text)).text;
}

export interface ParseProcOptions {
  /**
   * Identity used when an old file has no project.id. When opened from a draft, pass the draft id: the
   * old entries in the ownership table recorded the draft id, so the custom cards under its name can
   * still be recognized.
   */
  legacyId?: string;
}

/** .proc text → Project. Old bare Project JSON is also accepted */
export function parseProc(text: string, opts: ParseProcOptions = {}): Project {
  const doc = JSON.parse(text);
  // Do not force-read a newer format version: even if it reads in, it may silently drop fields this version does not recognize, and saving again would erase them. Report an error; the original file is untouched.
  if (doc?.format === PROC_FORMAT && !(Number.isSafeInteger(doc.version) && doc.version >= 1 && doc.version <= PROC_VERSION)) {
    throw new Error(UNSUPPORTED_PROC_TEXT(doc.version));
  }
  const project = doc?.format === PROC_FORMAT ? doc.project : doc;
  if (!project || typeof project !== "object" || !Array.isArray(project.tracks)) {
    throw new Error(tr("This is not a PromptCut project file"));
  }
  const id = typeof project.id === "string" && project.id ? project.id : opts.legacyId || newProjectId();
  // Python cards are archived; drop the definitions and nodes **before converting to a Project** (see pythonDrop.ts).
  // Placed before the spread on the next line: any later and the cardDefinitions of the raw JSON would already be spread in.
  publishPythonDrop(dropPythonNodes(project));
  const full: Project = { ...createEmptyProject(), ...project, id };
  // The stored asset addresses are dead blob: URLs or bare file names; swap them back by path into playable /@media addresses (see mediaUrls.ts)
  // A .proc can have been created by the desktop build, where the media file
  // lives in the shared Videos/PromptCut/media folder rather than this source
  // checkout's out/media.  Keep the absolute path behind the server's guarded
  // media endpoint so old projects remain playable after moving installations.
  const { media, missing } = restoreMediaUrls(full.media || [], { externalPathUrl: true });
  for (const m of missing) console.warn(`[proc] Missing asset: ${m.name} (${m.url})`);
  return { ...full, media };
}

/**
 * .proc text → Project, **and pour the script and chat inside back in**.
 *
 * Opening a project goes through this; do not use parseProc directly: it only parses the document
 * itself and the AI section would be missed, so the newly opened project would still hold the previous
 * project's chat. An old .proc has no ai section and is treated as empty:
 * that is, it clears the current chat, which is exactly how "one chat per project" should behave.
 */
export function loadProc(text: string, opts: ParseProcOptions = {}): Project {
  const project = parseProc(text, opts);
  let doc: ProcFile | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.format === PROC_FORMAT) doc = parsed;
  } catch {
    /* parseProc has already validated it once; getting here means it is a bare Project with no ai section */
  }
  // Do all the validations that can throw first, then touch anything: a file with a corrupted collaboration link must report an error, and must not first replace the current project's script and chat and then report
  checkAssociation(doc?.collaboration);
  applyProjectAi(doc?.ai ?? null);
  noteLoadedAssociation(project, doc?.collaboration);
  noteConvertedFrom(project, doc?.convertedFrom);
  noteLoadedCloudAssociation(project, doc?.cloudAssociation);
  restoreSnapshots(project, doc?.snapshots);
  // Reinstall the custom cards carried by the project onto this machine. Do not wait for it: after install, vite hot-updates and the cards show up in the stage and the card library on their own
  if (doc) void restoreProjectCards(bundledCardsOf(doc), project.id ?? null);
  return project;
}

/** Current project name, used as the default file name */
export function currentProjectName(): string {
  return getState().project.name || tr("Untitled");
}

/** Create an empty project and load it (the top bar's "New project" and the start page's "Start creating" both go through here) */
export function newProject(name = tr("Untitled")): Project {
  // The new project has no target yet; do not let it overwrite the previous project's file
  forgetSaveTarget();
  // The new project starts blank; neither the script nor the chat should carry over
  resetProjectAi();
  const project = createEmptyProject(name);
  actions.loadProject(project, `${name}${PROC_EXT}`);
  return project;
}

/* ── Where to save ────────────────────────────────────────────────
 * It used to create an <a download> and click it, and the browser dropped the file into "Downloads"
 * without asking, so the user had no chance to pick a directory and did not know where the file went.
 * Changed to use the File System Access API to pop up a real "Save as".
 *
 * One handle is remembered: the first save asks for a path once, and later saves of the same project
 * overwrite that file directly, without a dialog every time (consistent with proper editors).
 * **It must be cleared when switching projects**, otherwise the new project would overwrite the
 * previous project's file: newProject / openDraft both call forgetSaveTarget.
 */

/** showSaveFilePicker is not yet in lib.dom; declare only the little we use */
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

function pickerFn(): SaveFilePicker | null {
  const fn = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof fn === "function" ? fn : null;
}

/**
 * Generic "Save as": let the user pick a target; if the API is unavailable, return null for the caller to handle.
 *
 * It shares the same capability probe with writeProcToDisk, so the project does not end up with two sets of checks.
 * Likewise it must be the **first** await in the user gesture. If the user clicks cancel, it throws AbortError.
 */
export async function pickSaveTarget(
  suggestedName: string,
  description: string,
  accept: Record<string, string[]>,
): Promise<FileSystemFileHandle | null> {
  const picker = pickerFn();
  if (!picker) return null;
  return picker({ suggestedName, types: [{ description, accept }] });
}

let saveTarget: FileSystemFileHandle | null = null;

/** This project has been saved to a disk file during this open session (the target is remembered, so saving again does not ask) */
export function hasSaveTarget(): boolean {
  return saveTarget !== null;
}

/** Called when switching projects or drafts: the next save asks for the path again */
export function forgetSaveTarget(): void {
  saveTarget = null;
}
// After an expired cloud project is converted to a local project, the original file is kept: the next save asks for the target again and does not overwrite it
onGoneConversion(() => forgetSaveTarget());

export type SaveOutcome =
  /** `snapshotsSkipped`: the prerender snapshots hit the time limit, so this file carries no snapshots (the project content is complete) */
  | { kind: "saved"; where: string; snapshotsSkipped?: boolean }
  /** The user clicked cancel in the "Save as" dialog */
  | { kind: "cancelled" }
  /** This WebView has no File System Access API and can only fall back to a browser download */
  | { kind: "downloaded"; where: string };

/**
 * Write the .proc to disk.
 *
 * When `askAlways` is true, a dialog is forced (used by "Save as"); otherwise the position chosen last time is reused.
 * Mind the timing of the call: showSaveFilePicker needs a user gesture, so the click handler must call
 * it **first**, without awaiting anything else before it, or the gesture expires and a SecurityError is thrown.
 */
export async function writeProcToDisk(
  content: string | (() => Promise<string>),
  defaultName: string,
  { askAlways = false }: { askAlways?: boolean } = {},
): Promise<SaveOutcome> {
  // The content-supplying function is called only after the target is picked: when connected to the document service, first wait for all local changes to be confirmed (c65-design.md section 4),
  // and "Save as" must be the first await in the gesture
  const produce = () => (typeof content === "function" ? content() : Promise.resolve(content));
  const picker = pickerFn();
  if (!picker) {
    let text = await produce();
    text = await withFrameSnapshots(text);
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(a.href);
    return { kind: "downloaded", where: defaultName };
  }

  if (askAlways || !saveTarget) {
    try {
      saveTarget = await picker({
        suggestedName: defaultName,
        types: [{ description: tr("PromptCut project"), accept: { "application/json": [PROC_EXT] } }],
      });
    } catch (e) {
      // The user clicking cancel is a normal action, not an error; do not show an error box
      if ((e as Error)?.name === "AbortError") return { kind: "cancelled" };
      throw e;
    }
  }

  // Open the write stream only once the content (including prerender snapshots) is fully ready; write a temporary copy and replace the original file only on close; if any step fails, abort and the original file is unchanged (`safeWrite.ts`)
  const { text, timedOut } = await collectFrameSnapshots(await produce());
  await writeToHandle(saveTarget, text);
  return { kind: "saved", where: saveTarget.name, ...(timedOut ? { snapshotsSkipped: true } : {}) };
}
