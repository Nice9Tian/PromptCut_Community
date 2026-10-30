
import { VOLUME_KEY, state, set } from "../core";

export const playback = {

  /* ---------- 播放 ---------- */
  seek(t: number) {
    const clamped = Math.max(0, Math.min(state.project.duration, t));
    set({ t: clamped, playToken: state.playToken + 1 });
  },
  /** 播放中每帧推进,不重挂卡片 */
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
   * 重播:回到最早那张卡片,从头播一遍。
   *
   * 以前这里只加 playToken —— 那只是让「当前时刻活跃的卡片」重新挂载一次,
   * 用来重看入场动画。可播放到头时循环会 pause 并把 t 停在 duration,
   * 而 Stage 取的是 t >= start && t < end,末尾一个活跃 clip 都没有,
   * 于是「播完按重播」= 让零个卡片重新挂载 = 画面纹丝不动,按钮像是坏的。
   *
   * 有时间轴时用户会顺手把播放头拖回去所以不容易撞上;当时的对话式布局(已去掉)没有时间轴,
   * 只有一条细的迷你进度条,播完就只能按这个按钮 —— 于是问题就显出来了。
   *
   * 「在当前位置重看一遍入场动画」这个能力没丢:seek 本身就会加 playToken,
   * 点一下进度条即可。
   */
  replay() {
    // 播放范围从最早的卡片开始(和 Preview 的播放循环一致)
    let start = Infinity;
    for (const tr of state.project.tracks) for (const c of tr.clips) start = Math.min(start, c.start);
    set({ t: Number.isFinite(start) ? Math.max(0, start) : 0, playing: true, playToken: state.playToken + 1 });
  },
  /** 预览音量 0–1;调到非 0 顺手取消静音,和播放器习惯一致 */
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

  /* ---------- 选择 ---------- */
  select(ids: string[]) {
    set({ selection: ids });
  },
};
