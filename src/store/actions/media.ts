import { newId, type MediaAsset, type Transcript, type Shots, type Subjects } from "../../kernel/project";
import { stripMediaFromCuts } from "../../kernel/cuts";

import { state, setProject } from "../core";

export const media = {
  addMedia(asset: Omit<MediaAsset, "id"> & { id?: string }): MediaAsset {
    const m: MediaAsset = { ...asset, id: asset.id ?? newId("m") };
    setProject({ ...state.project, media: [...state.project.media, m] }, { undoable: false });
    return m;
  },
  /** 写入 / 清除素材的语音转文字结果(不进撤销栈) */
  setMediaShots(mediaId: string, shots: Shots | null) {
    const p = state.project;
    setProject(
      { ...p, media: p.media.map((m) => (m.id === mediaId ? { ...m, shots: shots ?? undefined } : m)) },
      { undoable: false },
    );
  },
  /** 写入 / 清除素材的主体检测结果(不进撤销栈,和镜头识别同一个道理) */
  setMediaSubjects(mediaId: string, subjects: Subjects | null) {
    const p = state.project;
    // 素材可能在检测跑完之前就被删了。不查一下的话 map 空转一圈、
    // setProject 白发一次通知,还会把「素材已经不在了」这件事藏起来。
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
   * 改一条素材的若干字段(不进撤销栈):入库回包写回、素材小尺寸后到补写 `tiers.small` 都走它。
   * patch 里值为 undefined 的键整个删掉(比如入库后清掉会话内的 `pending` 占位)。
   * 一律拷一份新对象、新数组再 setProject,不原地改 store 里的对象:共享项目里 store 的项目
   * 就是 docsync 的本地副本,原地改过的字段 diffProject 看不出变化,改动就到不了文档服务。
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
    // 认定过「确认缺失」的素材只改名字时,记录里记的名字跟着改:占位核对的是记录与素材现状逐项相同,
    // 名字只是显示用的,改名不该让占位失效(地址、类别、哈希变了是另一回事,那由后台检查重新判)。
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
    // 素材是项目级的:激活剪辑和停放剪辑里引用它的段都要清,不然切过去会出现指向已删素材的段
    setProject(stripMediaFromCuts({
      ...p,
      media: p.media.filter((m) => m.id !== mediaId),
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.mediaId !== mediaId) })),
    }, mediaId));
  },
};
