/**
 * Agent track tools: list_tracks / remove_track / update_track / move_track.
 *
 * From a real chat export (chat-diagnostics-20260911-150542): the user said "clean up the tracks"
 * and "delete all empty tracks", but the Agent only had add_track: it could create but not delete,
 * rename, or adjust vertical order, and had to dump 9 empty tracks and "rename Track 2 / Track 6 to
 * soundtrack" back onto the user to click manually. To first check which tracks exist, get_project
 * has 160,000 characters.
 *
 * Validation and gates are all here, while the store only modifies the document; extracted into a
 * factory so it can be tested directly in Node (trackTools.test.mjs).
 */

import type { Project, Track } from "../../kernel/project";
import { transitionsOf } from "../../kernel/transitions";
import { timelineDigest } from "./toolEcho";

export interface TrackStore {
  getState(): { project: Project };
  actions: {
    addTrack(name?: string, opts?: { index?: number }): Track;
    removeTracks(trackIds: string[]): void;
    updateTrack(trackId: string, patch: Partial<Pick<Track, "name" | "hidden" | "locked" | "muted">>): void;
    moveTrack(trackId: string, toIndex: number): void;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const NAME_MAX = 40;

/** Overview of a track: enough to decide whether to delete, what to name it, and which layer to place it on, without clip details */
export function describeTrack(t: Track, index: number) {
  const cards = t.clips.filter((c) => c.cardId).length;
  const span = t.clips.length ? [round2(Math.min(...t.clips.map((c) => c.start))), round2(Math.max(...t.clips.map((c) => c.end)))] : null;
  return {
    trackId: t.id,
    index,
    name: t.name,
    clipCount: t.clips.length,
    ...(t.clips.length ? { cards, media: t.clips.length - cards, span } : { empty: true }),
    ...(t.hidden ? { hidden: true } : null),
    ...(t.muted ? { muted: true } : null),
    ...(t.locked ? { locked: true } : null),
  };
}

export function describeTracks(p: Project) {
  return p.tracks.map(describeTrack);
}

function findTrack(p: Project, trackId: unknown): Track {
  const id = typeof trackId === "string" ? trackId.trim() : "";
  if (!id) throw new Error("trackId is required (get it from list_tracks)");
  const t = p.tracks.find((x) => x.id === id);
  if (!t) {
    const known = p.tracks.map((x) => `${x.id} "${x.name}"`).join(", ");
    throw new Error(`The current cut has no track ${id}. Existing: ${known}. A track belongs only to the currently active cut; to modify tracks of another cut, first call user_interface_switch_cut (this changes the interface of all members)`);
  }
  return t;
}

export function createTrackTools(store: TrackStore) {
  const project = () => store.getState().project;

  return {
    listTracks() {
      const p = project();
      return {
        ok: true,
        tracks: describeTracks(p),
        hint: "index 0 is at the top of the timeline and is drawn on the top layer. empty:true marks an empty track. hidden tracks do not appear in preview or export; muted tracks have no audio in the final video; locked tracks are protected by the user, and clips on them cannot be changed.",
      };
    },

    addTrack(args: { name?: unknown; index?: unknown }) {
      const name = args?.name === undefined ? undefined : String(args.name).trim();
      if (name !== undefined && (!name || name.length > NAME_MAX)) throw new Error(`name cannot be empty or longer than ${NAME_MAX} characters`);
      let index: number | undefined;
      if (args?.index !== undefined) {
        index = Number(args.index);
        if (!Number.isInteger(index) || index < 0) throw new Error("index is an integer starting from 0, 0 = the topmost track");
      }
      const t = store.actions.addTrack(name, index === undefined ? {} : { index });
      const p = project();
      return { ok: true, id: t.id, name: t.name, clips: [], index: p.tracks.findIndex((x) => x.id === t.id), tracks: describeTracks(p) };
    },

    /**
     * Delete tracks; multiple tracks can be deleted at once (one-step undo). The gate follows the same
     * logic as remove_cut: empty tracks are deleted directly; tracks with content require force + reason,
     * with the reason echoed to the user; locked tracks are not deleted; the last track is not deleted.
     */
    removeTrack(args: { trackId?: unknown; trackIds?: unknown; force?: unknown; reason?: unknown }) {
      const p = project();
      const raw = Array.isArray(args?.trackIds) ? args.trackIds : args?.trackId !== undefined ? [args.trackId] : [];
      if (raw.length === 0) throw new Error("Provide trackId (one track) or trackIds (delete several at once)");
      const targets = [...new Map(raw.map((id) => { const t = findTrack(p, id); return [t.id, t] as const; })).values()];
      if (targets.length >= p.tracks.length) throw new Error("At least one track must remain; to empty the whole cut, delete the clips in it, or use remove_cut");

      const locked = targets.filter((t) => t.locked);
      if (locked.length) {
        throw new Error(
          `${locked.map((t) => `"${t.name}"`).join(", ")} locked: locked by the user for protection, so not deleted.` +
            " Only when the user explicitly says to delete it, first unlock with update_track({ trackId, locked: false }) and then delete.",
        );
      }
      const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
      const full = targets.filter((t) => t.clips.length > 0);
      if (full.length && !args?.force) {
        throw new Error(
          `${full.map((t) => `"${t.name}" (${t.clips.length} clips)`).join(", ")} still has content; deleting a track also deletes its clips.` +
            " If you really need to delete, pass force:true and state the reason in reason (the user will see it); if you only want to clear empty tracks, remove these from trackIds.",
        );
      }
      if (args?.force && !reason) throw new Error("A force delete must state the reason in reason; the user will see this sentence");

      const gone = new Set(targets.flatMap((t) => t.clips.map((c) => c.id)));
      const doomed = transitionsOf(p).filter((tr) => gone.has(tr.aId) || (tr.bId !== undefined && gone.has(tr.bId)));
      store.actions.removeTracks(targets.map((t) => t.id));
      const q = project();
      return {
        ok: true,
        removed: targets.map((t) => ({ trackId: t.id, name: t.name, clipCount: t.clips.length })),
        ...(reason && full.length ? { reason } : null),
        ...(doomed.length
          ? { note: `Also removed ${doomed.length} transitions attached to the deleted clips; the fade on the other end, left on other tracks, has been erased` }
          : null),
        tracks: describeTracks(q),
        timeline: timelineDigest(q),
      };
    },

    /** Rename / hide / mute / lock: modify whichever is provided */
    updateTrack(args: { trackId?: unknown; name?: unknown; hidden?: unknown; muted?: unknown; locked?: unknown }) {
      const t = findTrack(project(), args?.trackId);
      const patch: Partial<Pick<Track, "name" | "hidden" | "locked" | "muted">> = {};
      if (args.name !== undefined) {
        const name = String(args.name).trim();
        if (!name || name.length > NAME_MAX) throw new Error(`name cannot be empty or longer than ${NAME_MAX} characters`);
        patch.name = name;
      }
      for (const key of ["hidden", "muted", "locked"] as const) {
        if (args[key] === undefined) continue;
        if (typeof args[key] !== "boolean") throw new Error(`${key} must be true or false, received ${JSON.stringify(args[key])}`);
        patch[key] = args[key] as boolean;
      }
      if (Object.keys(patch).length === 0) throw new Error("Provide at least one of name / hidden / muted / locked");
      store.actions.updateTrack(t.id, patch);
      const p = project();
      const i = p.tracks.findIndex((x) => x.id === t.id);
      const notes: string[] = [];
      if (patch.hidden) notes.push("Once hidden, this track does not appear in preview or export (its audio is gone too); this is not deletion");
      if (patch.muted) notes.push("Once muted, this track's audio is not included in preview or the final video; the picture is unaffected");
      if (patch.locked) notes.push("Once locked, clips on this track cannot be changed or deleted, and the track itself cannot be deleted");
      return { ok: true, track: describeTrack(p.tracks[i], i), ...(notes.length ? { note: notes.join(";") } : null) };
    },

    /** Adjust vertical order: index 0 = topmost, drawn on the highest layer */
    moveTrack(args: { trackId?: unknown; index?: unknown }) {
      const p = project();
      const t = findTrack(p, args?.trackId);
      const index = Number(args?.index);
      const last = p.tracks.length - 1;
      if (!Number.isInteger(index) || index < 0 || index > last) throw new Error(`index must be an integer from 0 to ${last} (0 = the topmost track)`);
      store.actions.moveTrack(t.id, index);
      return {
        ok: true,
        note: "Tracks nearer the top of the timeline are drawn on upper layers; audio has no layering, only the picture's occlusion changes",
        tracks: describeTracks(project()),
      };
    },
  };
}
