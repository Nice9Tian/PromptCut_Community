// With the .ts suffix: tsconfig enables allowImportingTsExtensions, and the unit tests run .ts
// files directly with node --test, which cannot resolve a transitive import without a suffix
// (projectAi.test.mjs tripped over exactly this back then).
import { AI_SESSION_PREFIX } from "./aiSessionKeys.ts";
import { tr } from "../i18n/index.ts";

/**
 * The "state of this machine at that moment" in a diagnostic report.
 *
 * # Why it exists
 *
 * The old chat diagnostic had only the chat itself: what the model said and which tools it called.
 * When a user reported "the Agent can see media from other projects", the report showed it blurting
 * out a file name that does not exist, but not **whether the media library actually had anything at
 * the time**, where the project is stored, or which mode the UI was in. So "a bug in the product"
 * and "an environment problem on this machine" could not be ruled out, and all that was left was
 * to ask the user back and forth.
 *
 * What this adds is that context: the mode, the project and its media, the number of visible chat
 * messages, and the backend session id.
 * The server half (Node process state, session file cabinet) is in server/harness/env-snapshot.mjs.
 *
 * # Why it is a pure function
 *
 * What it reads is scattered across four or five stores. Collecting the values is not hard; the
 * hard part is "which item got left out", and the cost of missing one is another round of asking
 * back and forth. So collection and assembly are kept apart: assembly is here, and unit-testable.
 */

export interface EnvMediaItem {
  id: string;
  name: string;
  kind: string;
  duration?: number;
  width?: number;
  height?: number;
  path?: string;
  hasTranscript?: boolean;
}

export interface EnvInput {
  /**
   * Legacy field: used to record the layout (Classic mode / chat-style). The chat-style layout has
   * been removed and is no longer sent, but old reports may still contain it
   */
  layout?: string;
  /** SKILL mode; pass null or { active:false } when it is off */
  skill?: { active: boolean; since?: string | null } | null;
  /** Number of Agent tabs open in the AI panel (multi-Agent; includes subagents started by spawn_agent) */
  agentTabs?: number;
  /** The current project; pass null if there is none */
  project?: {
    name?: string;
    filePath?: string | null;
    dirty?: boolean;
    duration?: number;
    width?: number;
    height?: number;
    fps?: number;
    media?: EnvMediaItem[];
    tracks?: Array<{ id: string; name?: string; clips?: unknown[] }>;
  } | null;
  /** Number of chat messages visible in the UI */
  visibleMessages?: number;
  /** localStorage; pass undefined to mean it could not be read */
  storage?: Pick<Storage, 'length' | 'key' | 'getItem'> | null;
  /** Browser/WebView info */
  agent?: { userAgent?: string; language?: string; platform?: string } | null;
  /** Viewport, used when investigating layout problems */
  viewport?: { width: number; height: number; dpr?: number } | null;
}

/**
 * Truncate values that are too long: localStorage has held whole drafts, and a single entry
 * can blow up the report
 */
const VALUE_LIMIT = 200;

/**
 * Keys whose **original value** may go into the report. It is an allowlist, not a prefix wildcard.
 *
 * It used to say "accept anything starting with `ai` or `pc.`", so `pc.ai.script` (the script body
 * the user wrote by hand, see ai/script.ts) silently went into the report, and this report is
 * **uploaded** (ai/reportSubmit.ts). Worse, a wildcard means any `ai*` / `pc.*` key added in the
 * future is automatically sent out too, and whoever adds the key will not think of that layer.
 *
 * So it is reversed: only the pure settings explicitly listed carry their value; for the rest the
 * report only says "such a key exists, and how long it is". For troubleshooting, "which settings
 * exist and how long each is" is enough in itself; the original text is not needed.
 */
const VALUE_SAFE = new Set([
  "aiProvider", "aiShowThinking", "aiViewMode", "aiSetupFace", "aiSetupDone",
  "pc.volume", "pc.muted", "pc.deps.sttDismissed", "pc.agentTabs.active",
]);
/**
 * Everything stored under these prefixes is an enum / switch / number (driver name, model name,
 * thinking tier, layout tab, panel width), so it is safe to include the value, and it is exactly
 * what you want to see when troubleshooting.
 *
 * The whole "pc.ai." prefix must **not** be let through: the script the user wrote by hand lives
 * under pc.ai.script. So the settings under pc.ai. are listed one by one. Better to list too few:
 * listing too few only loses one line of information, while listing too many sends out the user's
 * original content.
 */
const VALUE_SAFE_PREFIX = [
  "pc.ai.model.", "pc.ai.effort.", "pc.ai.fast.", "pc.ai.deepAuto.",
  "pc.ai.deepAutoRounds.", "pc.ai.schemaCompat.", "pc.ai.toolProtocol.",
  "pc.left.", "pc.right.", "pc.timeline.",
];

function safeToShow(key: string): boolean {
  return VALUE_SAFE.has(key) || VALUE_SAFE_PREFIX.some((p) => key.startsWith(p));
}

/** One plain sentence saying "which mode it is now", so nobody has to infer it from three booleans */
export function describeMode(input: EnvInput): string {
  // Two working modes (user-workflow.md "Working mode"): Classic mode / SKILL (the desktop app's
  // Agent connects to the same project via MCP, and the AI panel stays available as usual)
  const bits = [input.skill?.active ? tr("SKILL mode (the desktop app's Agent edits this project via MCP, the AI panel still works as usual)") : tr("Classic mode")];
  if ((input.agentTabs ?? 1) > 1) bits.push(tr("Multi-Agent ({0} tabs)", input.agentTabs));
  return bits.join(' + ');
}

/**
 * Which directories the media is under.
 *
 * This item is listed separately because a problem like "a new project landing in a temp directory"
 * can only be seen from the directories: the media names look normal, but the path is under %TEMP%,
 * or still points at the previous project's folder altogether.
 */
export function mediaDirs(media: EnvMediaItem[]): string[] {
  const seen = new Set<string>();
  for (const m of media) {
    if (!m.path) continue;
    const cut = Math.max(m.path.lastIndexOf('\\'), m.path.lastIndexOf('/'));
    // cut === 0 is a file at the posix root (/a.mp4): the directory is the root, not "no directory"
    seen.add(cut > 0 ? m.path.slice(0, cut) : cut === 0 ? '/' : tr("(no directory)"));
  }
  return [...seen];
}

/**
 * The localStorage keys related to the AI / editor. Secret keys are not stored here (they are in
 * the server's ai.json)
 */
function localKeys(storage: EnvInput['storage']): { sessionIds: Record<string, string>; settings: Record<string, string>; note?: string } {
  if (!storage) return { sessionIds: {}, settings: {}, note: tr("Can't read localStorage") };
  const sessionIds: Record<string, string> = {};
  const settings: Record<string, string> = {};
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k) continue;
      const v = storage.getItem(k);
      if (v === null) continue;
      const short = v.length > VALUE_LIMIT ? tr("{0}… ({1} characters in total)", v.slice(0, VALUE_LIMIT), v.length) : v;
      if (k.startsWith(AI_SESSION_PREFIX)) sessionIds[k] = short;
      else if (!/^(ai|pc\.)/.test(k)) continue;
      // Keys outside the allowlist only report "such a key exists, and how long it is": troubleshooting
      // needs "which settings exist", not the original text. See VALUE_SAFE
      else settings[k] = safeToShow(k) ? short : tr("(has a value, {0} characters in total; not in the allowlist, original text omitted)", v.length);
    }
  } catch {
    return { sessionIds, settings, note: tr("Error while reading localStorage, the items below may be incomplete") };
  }
  return { sessionIds, settings };
}

export function buildEnvReport(input: EnvInput): Record<string, unknown> {
  const media = input.project?.media || [];
  const tracks = input.project?.tracks || [];
  const clips = tracks.reduce((n, t) => n + (t.clips?.length || 0), 0);
  const keys = localKeys(input.storage);
  const sessionCount = Object.keys(keys.sessionIds).length;

  return {
    note: tr("The state of this machine at the moment the problem occurred. Used to tell \"a product bug\" apart from \"an environment problem on this machine\": with the chat alone, neither can be ruled out."),
    mode: {
      mode: input.skill?.active ? 'skill' : 'classic',
      skillActive: !!input.skill?.active,
      skill: input.skill?.active ? input.skill : null,
      agentTabs: input.agentTabs ?? 1,
      note: describeMode(input),
    },
    project: input.project
      ? {
          name: input.project.name,
          // null means "never saved to disk". While a new project has not been saved, its media lands in a
          // temp directory, and a pile of odd things the user sees all come from there, so this item must
          // be stated explicitly
          filePath: input.project.filePath ?? null,
          saved: !!input.project.filePath,
          savedNote: input.project.filePath ? undefined : tr("This project has not been saved yet, its media and working directory are under the temp directory"),
          unsavedChanges: !!input.project.dirty,
          canvas: { width: input.project.width, height: input.project.height, fps: input.project.fps, duration: input.project.duration },
          tracks: tracks.map((t) => ({ id: t.id, name: t.name, clips: t.clips?.length || 0 })),
          clipCount: clips,
        }
      : null,
    media: {
      count: media.length,
      // The user says "the media library is empty" while the model still manages to name a file;
      // this line is there to cross-check the two
      note: media.length === 0 ? tr("The media library is empty: if the model can name any media, that was not read from this project") : tr("The media library has {0} files", media.length),
      dirs: mediaDirs(media),
      items: media.map((m) => ({
        id: m.id, name: m.name, kind: m.kind,
        duration: m.duration, width: m.width, height: m.height,
        path: m.path ?? tr("(no disk path, possibly a blob that hasn't been uploaded yet)"),
        hasTranscript: !!m.hasTranscript,
      })),
    },
    chat: {
      visibleMessages: input.visibleMessages ?? null,
      backendSessionIds: keys.sessionIds,
      /*
       * The UI is empty but the backend continues from the previous history, and this mismatch shows
       * no symptom in the UI at all. Putting the two numbers side by side lets the report reveal it at a
       * glance: 0 visible messages + the session id still present
       * = the server will read the old history back in full from harness-sessions (see aiSessionKeys.ts).
       */
      note: sessionCount === 0
        ? tr("No leftover backend session ids: this round starts from scratch")
        : tr("{0} backend session ids are still left: check them against the server sessions section to see how much history each one carries", sessionCount),
    },
    localSettings: keys.settings,
    localNote: keys.note,
    agent: input.agent || null,
    viewport: input.viewport || null,
  };
}
