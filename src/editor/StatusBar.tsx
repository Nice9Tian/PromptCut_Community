import { useStore } from "../store/project";
import { tr } from "../i18n/index.ts";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * Bottom status bar (color diagnosis and fix v2, full screen): 28 high, the same deepest tier of
 * background as the window bar, small monospace text.
 * Ready · track count and card count · duration · save status on the right (green dot saved / amber
 * dot unsaved changes; online pages are all cloud projects, so the local draft save status is not shown).
 * Display only, carries no actions.
 */
export function StatusBar() {
  const tracks = useStore((s) => s.project.tracks);
  const duration = useStore((s) => s.project.duration);
  const dirty = useStore((s) => !ONLINE_BUILD && s.dirty);
  const playing = useStore((s) => s.playing);
  const clipCount = tracks.reduce((n, t) => n + t.clips.length, 0);

  return (
    <div className="pc-statusbar" data-pc="statusbar" role="status" aria-live="polite">
      <span>{playing ? tr("Playing") : tr("Ready")}</span>
      <span>
        {tr("Tracks {0} · {1} clips", tracks.length, clipCount)}
      </span>
      <span>{tr("Duration {0} s", duration.toFixed(2))}</span>
      {!ONLINE_BUILD && (
        <span className="pc-statusbar-right">
          <span className={`pc-statusbar-dot${dirty ? " is-dirty" : ""}`} aria-hidden="true" />
          {dirty ? tr("Unsaved changes") : tr("Draft saved")}
        </span>
      )}
    </div>
  );
}
