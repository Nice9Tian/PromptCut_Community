/**
 * Role prompts. One .md file per role; just drop it into this directory, no change is needed here.
 *
 * "One-click effects" runs these roles one after another in the order given in ORDER:
 * first the editing director arranges the media into a video, then the effects assistant adds
 * captions and motion graphics.
 * They are split into roles rather than one long prompt because the two steps need different
 * things: arranging the video requires seeing all the media first, and adding effects requires
 * having a transcript first, and mixing them in one round makes the model prone to neglecting one
 * for the other.
 *
 * The multi-Agent `spawn_agent` (plan agent-workflow-plan.md A3) also takes the preset role prompts
 * from this directory, and the server reads them by the same rules (`server/agent/agent-roles.mjs`).
 *
 * File names use ASCII, and the Chinese name goes in the top-level heading inside the file: these
 * names end up in build outputs and packaging scripts, and ASCII paths are least likely to go wrong
 * in the various command-line environments on Windows.
 */

export interface Role {
  /** The file name without its extension, e.g. director */
  id: string;
  /** The top-level heading in the file, e.g. "Editing director" */
  name: string;
  /** All the body text below the heading; this is what is sent to the AI */
  prompt: string;
  /**
   * What kind of model capability this role needs. Written in the frontmatter at the top of the .md.
   *
   * Nothing is actually routed by it yet: all roles run on the provider the user selected. The field is
   * kept so that "planning" can later go to a strong model and "execution" to a fast model: then only
   * resolveModelFor needs to change, without coming back to touch every role.
   */
  capability: Capability;
}

/** The role's requirement on the model. When a tier is added, update the comment in resolveModelFor too. */
export type Capability = "planning" | "execution";

/**
 * The run order. Files not listed are still read (and can be called individually), but are not part
 * of "one-click effects".
 * To add a role in the future: create the .md and put its id in this array.
 */
export const WORKFLOW_ORDER = ["director", "fx-assistant"] as const;

const files = import.meta.glob<string>("./*.md", { eager: true, query: "?raw", import: "default" });

/** Strips the leading --- frontmatter ---, returning the key-value pairs inside and the remaining body */
function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    // A # comment is allowed after the value; cut it off
    if (kv) meta[kv[1]] = kv[2].replace(/\s+#.*$/, "").trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

function parse(path: string, rawFile: string): Role {
  const id = path.replace(/^\.\//, "").replace(/\.md$/, "");
  const { meta, body: raw } = splitFrontmatter(rawFile);
  // If not written, count it as "execution": most roles do the work and planning roles are the
  // minority, so let the minority declare it explicitly
  const capability: Capability = meta.capability === "planning" ? "planning" : "execution";
  const lines = raw.split(/\r?\n/);
  const headingAt = lines.findIndex((l) => l.startsWith("# "));
  const name = headingAt >= 0 ? lines[headingAt].slice(2).trim() : id;
  const prompt = (headingAt >= 0 ? lines.slice(headingAt + 1) : lines).join("\n").trim();
  return { id, name, prompt, capability };
}

/** All the roles in the directory, sorted by file name */
export const ALL_ROLES: Role[] = Object.entries(files)
  .map(([path, raw]) => parse(path, raw))
  .filter((r) => r.prompt !== "")
  .sort((a, b) => a.id.localeCompare(b.id));

/**
 * Picks a model by the role's capability tier. **Currently a placeholder implementation: it always
 * returns null, meaning "use the one the user selected".**
 *
 * The function is kept to separate the two questions "who does it" and "which model to use". Later,
 * to send planning roles to a strong model and execution roles to a fast model, only this one place
 * needs to change; callers that choose a model by role in the future all ask it, and there is no need
 * to go back and change every role.
 *
 * Returns a provider id ('claude' | 'codex' | 'agy' | 'api'); null means unspecified.
 */
export function resolveModelFor(capability: Capability): string | null {
  // It will probably look like this in the future:
  //   planning  → strong model (if the breakdown and trade-offs are wrong, everything after is wasted)
  //   execution → fast model (the steps are straightforward, and it wins on being cheap and fast)
  void capability;
  return null;
}

/** The roles that "one-click effects" runs in order */
export const WORKFLOW_ROLES: Role[] = WORKFLOW_ORDER
  .map((id) => ALL_ROLES.find((r) => r.id === id))
  .filter((r): r is Role => !!r);
