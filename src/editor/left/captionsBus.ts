/**
 * 「去字幕分页转写这份素材」的全局入口。
 *
 * 左栏的字幕分页归 LeftPanel 管,但想打开它的人不止左栏自己:时间轴上右键一段视频 /
 * 音频也要能直接跳过去转写。两边隔着好几层组件、又不共享 store 里的界面状态,
 * 所以用一个 window 事件搭桥:谁都能喊,LeftPanel 挂载时监听并切到字幕分页。
 */
const EVENT = "pc-open-captions";

export function requestCaptions(mediaId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { mediaId } }));
}

export function onCaptionsRequest(fn: (mediaId: string) => void): () => void {
  const handler = (e: Event) => {
    const id = (e as CustomEvent<{ mediaId?: string }>).detail?.mediaId;
    if (typeof id === "string" && id) fn(id);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
