/**
 * 这个文档里此刻挂着的 gl 平面(R9 M1 / M3)。
 *
 * `Stage` 给带 `canvas` 契约的片段在包裹层里渲一个 `<canvas data-pc-gl-plane={clipId}>`(`GlPlane`),
 * 它每次提交都在 layout effect 里把「这一拍要画什么」登记到这里:本地秒 `t`、本地帧号、参数、
 * 重挂载代数、尺寸、这一拍该不该画。`glHost` 发 `beat` 时读这张表 —— 所以宿主只要先 `flushSync`
 * 提交,再 `glHost.beat()`,拿到的就是刚提交的那一帧。
 *
 * 模块级单例:每个文档(两个舞台、导出页)各有一份模块实例,互不相干。
 */

export interface GlPlaneEntry {
  clipId: string;
  canvas: HTMLCanvasElement;
  kind: "gl" | "three" | "2d";
  programId: string;
  /** 画布像素尺寸(= 片段实体框) */
  w: number;
  h: number;
  /** 传给卡的本地秒(和传给组件的那个 `t` 同一个值) */
  t: number;
  /** 这一拍的本地帧号 —— 和包裹层 `data-pc-local-frame` 同一个算式;贴上位图后写进 `data-pc-gl-frame` */
  frame: number;
  params: Record<string, unknown>;
  paramsKey: string;
  /** 重挂载代数(`remountGen ?? playToken`):变了 = 这张卡要 `reset` */
  gen: number;
  /** 在 `suppressed` 里,或在 `snapshots` 里且不在 `settling` 里:这一拍不画(M3) */
  skip: boolean;
  textures: Array<{ name: string; url: string }>;
  stage: { width: number; height: number; camera3dFov?: number };
}

export const glPlanes = new Map<string, GlPlaneEntry>();
