
import { VOLUME_KEY, state, set } from "../core";

export const playback = {

  /* ---------- Playback ---------- */
  seek(t: number) {
    const clamped = Math.max(0, Math.min(state.project.duration, t));
    set({ t: clamped, playToken: state.playToken + 1 });
  },
  /** Advances each frame during playback without remounting cards */
  tick(t: number) {
    set({ t });
  },
  play() {
    set({ playing: true });
  },
  pause() {
    set({ playing: false });
  },
  togglePlay() {
    set({ playing: !state.playing });
  },
  /**
   * Replay: returns to the earliest card and plays from the beginning.
   *
   * Previously, this only incremented playToken: that merely remounted "cards active at the
   * current moment" once to re-watch entrance animations. But when playback reaches the end, the
   * loop pauses and parks t at duration, while Stage checks t >= start && t < end, leaving zero
   * active clips at the end. Thus "replay after playback ends" = remounting zero cards = visual output
   * completely still, and the button feels broken.
   *
   * With a timeline, users naturally scrub the playhead back, making this hard to encounter;
   * the chat layout at the time (now removed) had no timeline, only a thin mini progress bar, so
   * pressing this button was the only option once playback ended: thus the issue surfaced.
   *
   * The ability to "re-watch entrance animations at the current position" is not lost: seek itself
   * increments playToken, so clicking the progress bar is sufficient.
   */
  replay() {
    // Playback range starts from the earliest card (consistent with Preview's playback loop)
    let start = Infinity;
    for (const tr of state.project.tracks) for (const c of tr.clips) start = Math.min(start, c.start);
    set({ t: Number.isFinite(start) ? Math.max(0, start) : 0, playing: true, playToken: state.playToken + 1 });
  },
  /** Preview volume 0–1; setting to non-zero automatically unmutes, matching player conventions */
  setVolume(v: number) {
    const volume = Math.max(0, Math.min(1, v));
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {}
    set({ volume, muted: volume === 0 ? state.muted : false });
  },
  toggleMute() {
    set({ muted: !state.muted });
  },

  /* ---------- Selection ---------- */
  select(ids: string[]) {
    set({ selection: ids, ...(ids.length > 0 ? { selectedCameraId: null } : {}) });
  },
  selectCamera(cameraId: string | null) {
    set({ selectedCameraId: cameraId, ...(cameraId ? { selection: [] } : {}) });
  },
};
