import { useStore } from "../store/project";

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * 底部状态栏(配色诊断与修正 v2 整屏):28 高,和窗口栏同一档最深的底,等宽小字。
 * 就绪 · 序列数与卡片数 · 时长 · 右侧保存状态(绿点已保存 / 琥珀点有未保存改动;在线页面都是云端项目,不显示本机草稿保存状态)。
 * 纯展示,不带任何操作。
 */
export function StatusBar() {
  const tracks = useStore((s) => s.project.tracks);
  const duration = useStore((s) => s.project.duration);
  const dirty = useStore((s) => !ONLINE_BUILD && s.dirty);
  const playing = useStore((s) => s.playing);
  const clipCount = tracks.reduce((n, t) => n + t.clips.length, 0);

  return (
    <div className="pc-statusbar" data-pc="statusbar" role="status" aria-live="polite">
      <span>{playing ? "播放中" : "就绪"}</span>
      <span>
        序列 {tracks.length} · {clipCount} 个片段
      </span>
      <span>时长 {duration.toFixed(2)} s</span>
      {!ONLINE_BUILD && (
        <span className="pc-statusbar-right">
          <span className={`pc-statusbar-dot${dirty ? " is-dirty" : ""}`} aria-hidden="true" />
          {dirty ? "有未保存的改动" : "已保存草稿"}
        </span>
      )}
    </div>
  );
}
