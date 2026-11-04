/**
 * Three-way merge of cloud groups (ruling V22-08: not "last write wins"; when two devices edit at the same time,
 * the changes from both sides must be kept).
 *
 * When to use: `put` returned 409 (the cloud copy is newer than the one I last fetched). Three inputs:
 *   - `base`   the copy I last fetched from the cloud (the common starting point of both sides); if I never
 *              fetched one (first time, cache lost), pass `null`, treated as empty;
 *   - `mine`   what I have now (including changes not yet uploaded);
 *   - `theirs` the current cloud copy returned with the 409.
 * Merge them into a new one, then upload again with the version number of `theirs`.
 *
 * Rules (groups, project entries and chat entries are all aligned by ID and merged per field):
 *   - **Fields** (name, owning group, pin, archive): if only I changed it, mine wins; if only the other side
 *     changed it, theirs wins; **if both changed the same field, mine wins**;
 *   - **Additions**: union; if both sides added the same ID, the whole entry follows mine;
 *   - **Deletions**: it counts as deleted only if one side deleted it and the other side **did not change** it;
 *     if the other side changed it afterwards, keep it (with their changes), so a deletion never swallows
 *     something someone else just edited;
 *   - **Order**: if I moved the order (compare only the relative order of entries present on both sides), use
 *     mine; if I didn't, use theirs.
 *     An entry added on the other side is inserted after its former previous neighbor (at the very front if it
 *     had none), so a "new group" stays last and a "newly appearing project" stays first;
 *   - **Cascade**: if the other side deleted a group and I put a project into it, the project goes back to
 *     "not in any group" (consistent with the rule for deleting a group).
 * This is only reached when the same person edits on two devices at once; no cleverness, just don't lose anything.
 *
 * Pure function, always returns new objects, never mutates in place (repo constraint). Unit test:
 * `orgMerge.test.mjs`.
 */
import type { OrgChat, OrgGroup, OrgProject, OrgState } from "./vibeOrg.ts";

interface Spec<T> {
  key: (t: T) => string;
  /** Fields that take part in per-field merging, compared with `eq` */
  fields: readonly (keyof T)[];
}

/** Value used for comparison: for flags (pin, archive), unset and written as false are the same thing; other fields compare by value, with missing treated as null */
const norm = (field: PropertyKey, v: unknown): unknown => (field === "pinned" || field === "archived" ? !!v : (v ?? null));

function fieldEq<T>(x: T, y: T, fields: readonly (keyof T)[]): boolean {
  return fields.every((f) => norm(f, x[f]) === norm(f, y[f]));
}

/** Merge two lists "aligned by ID" */
export function mergeList<T>(base: readonly T[], mine: readonly T[], theirs: readonly T[], spec: Spec<T>): T[] {
  const { key, fields } = spec;
  const index = (list: readonly T[]) => new Map(list.map((t) => [key(t), t]));
  const b = index(base);
  const m = index(mine);
  const t = index(theirs);

  const merged = new Map<string, T>();
  for (const k of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const bi = b.get(k);
    const mi = m.get(k);
    const ti = t.get(k);
    if (!bi) {
      // Additions: if both sides added the same ID, mine wins; if only one side added it, it is that one
      const pick = mi ?? ti;
      if (pick) merged.set(k, pick);
      continue;
    }
    if (!mi && !ti) continue; // Both sides deleted it
    if (!mi) {
      // I deleted it: it counts as deleted only if the other side didn't change it; if they did, keep it
      if (!fieldEq(bi, ti!, fields)) merged.set(k, ti!);
      continue;
    }
    if (!ti) {
      if (!fieldEq(bi, mi, fields)) merged.set(k, mi);
      continue;
    }
    // Present on both sides: per field, if only I changed it mine wins, otherwise theirs (if both changed the same
    // field, "only I changed it" also holds, so mine wins)
    const out: T = { ...ti };
    for (const f of fields) {
      if (norm(f, bi[f]) !== norm(f, mi[f])) (out as Record<keyof T, unknown>)[f] = mi[f];
    }
    // A flag field that was never set stays unset: if the other copy doesn't have it and mine doesn't either, don't invent a false
    merged.set(k, cleanFlags(out));
  }

  // Order: if I moved it (the relative order of entries present on both sides changed) use mine, otherwise theirs
  const common = base.map(key).filter((k) => m.has(k));
  const mineOrder = mine.map(key).filter((k) => b.has(k));
  const baseOrder = common;
  const mineMoved = mineOrder.length !== baseOrder.length || mineOrder.some((k, i) => k !== baseOrder[i]);
  const primary = (mineMoved ? mine : theirs).map(key);
  const other = (mineMoved ? theirs : mine).map(key);

  const seq = primary.filter((k) => merged.has(k));
  const have = new Set(seq);
  // Entries added on the other side (or present only on the other side because "the other side changed it, so keep
  // it"): insert after their previous neighbor on that side
  other.forEach((k, i) => {
    if (have.has(k) || !merged.has(k)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const prev = seq.indexOf(other[j]);
      if (prev >= 0) { at = prev + 1; break; }
    }
    seq.splice(at, 0, k);
    have.add(k);
  });
  // Entries in neither side's order (an edge case where the other side kept something only in base): append at the end, don't lose them
  for (const k of merged.keys()) if (!have.has(k)) seq.push(k);
  return seq.map((k) => merged.get(k)!);
}

/** Pin and archive are written only when true: `false` and unset are the same thing, and what is stored never carries false, consistent with `flagsOf` in `vibeOrg.ts` */
function cleanFlags<T>(x: T): T {
  const r = { ...x } as Record<string, unknown>;
  if (r.pinned !== true) delete r.pinned;
  if (r.archived !== true) delete r.archived;
  return r as T;
}

const GROUP: Spec<OrgGroup> = { key: (g) => g.id, fields: ["name", "pinned", "archived"] };
const PROJECT: Spec<OrgProject> = { key: (p) => p.id, fields: ["groupId", "pinned", "archived"] };
const CHAT: Spec<OrgChat> = { key: (c) => `${c.projectId}\u0000${c.id}`, fields: ["pinned", "archived"] };

/** Merge into one cloud organization copy. If `base` is missing, treat it as empty (everything on both sides counts as an "addition") */
export function mergeOrg(base: OrgState | null, mine: OrgState, theirs: OrgState): OrgState {
  const empty = { groups: [] as OrgGroup[], projects: [] as OrgProject[], chats: [] as OrgChat[] };
  const b = base ?? empty;
  const groups = mergeList(b.groups, mine.groups, theirs.groups, GROUP);
  const groupIds = new Set(groups.map((g) => g.id));
  const projects = mergeList(b.projects, mine.projects, theirs.projects, PROJECT)
    // Cascade: the owning group was deleted by the other side, so the project goes back to not being in any group
    .map((p) => (p.groupId && !groupIds.has(p.groupId) ? { ...p, groupId: null } : p));
  const chats = mergeList(b.chats, mine.chats, theirs.chats, CHAT);
  return { v: 1, realm: theirs.realm, groups, projects, chats };
}
