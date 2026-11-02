import { newId, type MediaAsset, type Transcript, type Shots, type Subjects } from "../../kernel/project";
import { stripMediaFromCuts } from "../../kernel/cuts";

import { state, setProject } from "../core";

export const media = {
  addMedia(asset: Omit<MediaAsset, "id"> & { id?: string }): MediaAsset {
    const m: MediaAsset = { ...asset, id: asset.id ?? newId("m") };
    setProject({ ...state.project, media: [...state.project.media, m] }, { undoable: false });
    return m;
  },
  /** Writes / clears speech-to-text results for an asset (does not enter undo stack) */
  setMediaShots(mediaId: string, shots: Shots | null) {
    const p = state.project;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, shots: shots ?? undefined } : m)) },
      { undoable: false },
    );
  },
  /**
   * Writes / clears subject detection results for an asset (does not enter undo stack, same
   * principle as shot detection)
   */
  setMediaSubjects(mediaId: string, subjects: Subjects | null) {
    const p = state.project;
    // The asset might have been deleted before detection finished running. Without checking,
    // the map spins needlessly, setProject sends an unnecessary notification, and hides the fact
    // that "the asset is already gone".
    if (!p.media.some((m) => m.id === mediaId)) return;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, subjects: subjects ?? undefined } : m)) },
      { undoable: false },
    );
  },
  setMediaTranscript(mediaId: string, transcript: Transcript | null) {
    const p = state.project;
    if (!p.media.some((m) => m.id === mediaId)) return;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, transcript: transcript ?? undefined } : m)) },
      { undoable: false },
    );
  },
  /**
   * Modifies several fields of an asset (does not enter undo stack): writing back store responses
   * and backfilling `tiers.small` when small-size assets arrive later both go through this. Keys with
   * undefined values in patch are deleted entirely (e.g. clearing `pending` placeholders in the
   * session after storing). Always copy a new object and new array before setProject, never mutating
   * objects in the store in place: in a shared project, the project in the store is docsync's local
   * replica; fields mutated in place show no changes in diffProject, so changes never reach
   * the document service.
   */
  updateMedia(mediaId: string, patch: Partial<Omit<MediaAsset, "id">>) {
    const p = state.project;
    const cur = p.media.find((m) => m.id === mediaId);
    if (!cur) return;
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    // When only renaming an asset identified as "confirmed missing", the name recorded in the record
    // updates accordingly: the placeholder check verifies the record matches current asset status item
    // by item; the name is only for display, and renaming should not invalidate the placeholder (changes
    // to address, category, or hash are another matter, re-evaluated by background checks).
    if (cur.missingMaterial && typeof patch.name === "string" && !("missingMaterial" in patch) && cur.missingMaterial.original?.name === cur.name) {
      next.missingMaterial = { ...cur.missingMaterial, original: { ...cur.missingMaterial.original, name: patch.name } };
    }
    setProject({ ...p, media: p.media.map((m) => (m === cur ? (next as unknown as MediaAsset) : m)) }, { undoable: false });
  },
  setMediaPath(mediaId: string, path: string) {
    const p = state.project;
    if (!p.media.some((m) => m.id === mediaId)) return;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, path } : m)) },
      { undoable: false },
    );
  },
  removeMedia(mediaId: string) {
    const p = state.project;
    // Assets are project-level: clips referencing them in active and parked cuts must be cleared,
    // otherwise switching over will produce clips pointing to deleted assets
    setProject(stripMediaFromCuts({
      ...p,
      media: p.media.filter((m) => m.id !== mediaId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.mediaId !== mediaId) })),
    }, mediaId));
  },
};
