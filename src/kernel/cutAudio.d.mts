import type { Project } from "./project";
export interface CutEnvelope {
  start: number;
  end: number;
  fadeIn?: number;
  fadeOut?: number;
  /** 只给画面用;声音那份包络不带它(段的不透明度不是音量) */
  opacity?: number;
}
/** 展开出来的片段身上的记号:原片段 id、经过的剪辑段 id(外层在前) */
export interface CutAudioOrigin {
  clipId: string;
  segments: string[];
  /** 原片段住在哪条剪辑里(被引用的那条;卡片声音按它在那条剪辑里的原片段核身份) */
  cutId: string;
}
export function envelopeAt(e: CutEnvelope, t: number, withOpacity?: boolean): number;
export function audioProjectOf<P extends Project>(p: P): P;
