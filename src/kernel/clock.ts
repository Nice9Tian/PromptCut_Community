/**
 * 时钟。
 * 预览:performance.now() 驱动 rAF 自走。
 * 导出:导出脚本每帧显式下发 window.__pcExportMs,页面时钟不可信
 *      (Chrome 虚拟时间在资源加载时会偷偷快进)。任何需要"现在几点"的代码都走 clockNow()。
 */
declare global {
  interface Window {
    __pcExportMs?: number;
    __pcClockRate?: number;
    __pcSetT?: (sec: number, directSec?: number) => void;
    __pcReady?: boolean;
    __pcTimeline?: unknown;
    __pcCardPlan?: () => unknown;
    /** 导出:重新挂载全部卡片(playToken+1) */
    __pcRestartCards?: () => void;
    /** 导出:每帧推进完虚拟时间后,把所有 Web Animations 的 currentTime 钉到导出时间 */
    __pcSyncAnims?: () => void;
    /** 导出:清空动画锚点(正式计帧前调一次) */
    __pcResetAnims?: () => void;
    /** 导出:本帧素材(视频 seek 等)就绪 */
    __pcFrameReady?: () => Promise<void>;
    __pcFrameWorkStatus?: () => { label: string; error?: string }[];
    /**
     * 导出:经 exportClock 包过的 rAF 被注册了多少次。
     * rAF 驱动的 JS 动画(Motion 的 MotionValue)每帧都会重新注册下一帧,停了就不再注册,
     * 所以「这一格内计数没涨」等价于「没有 JS 动画在跑」。document.getAnimations() 看不见这类动画。
     */
    __pcRafCount?: number;
    /** 导出:未被计数的原始 rAF。导出脚本自己等帧用它,免得把 __pcRafCount 顶起来。 */
    __pcRealRaf?: (cb: FrameRequestCallback) => number;
    /** 舞台:被接管之前的 performance.now(量探针 / RPC 耗时用,舞台时间是虚拟的) */
    __pcRealNow?: () => number;
    /** 舞台:真 setTimeout(暂停态虚拟时钟不动,兜底计时要靠它) */
    __pcRealSetTimeout?: (cb: () => void, ms?: number) => number;
    /** 舞台:真 setInterval(E4b 之后 window.setInterval 登记在虚拟时钟上) */
    __pcRealSetInterval?: (cb: () => void, ms?: number) => number;
    /** 舞台 / 导出页:被 pinEntropy 钉住之前的 Date.now(E4b) */
    __pcRealDateNow?: () => number;
    /** 导出页 / 预渲染快照页:实体几何的导出面(见 render/solid.ts),给 puppeteer 侧 page.evaluate 用 */
    __pcSolid?: import('../render/solid').SolidApi;
    /** 导出页:canvas 的实体框(画布像素坐标),同 __pcSolid.canvasPaintedBox */
    __pcCanvasBox?: import('../render/solid').SolidApi['canvasPaintedBox'];
    /** 舞台页:RPC 方法表(父页走 postMessage;这里挂着只给测试页 / puppeteer 直接调) */
    __pcStage?: import('../render/stageRpc').StageRpcApi;
    /**
     * 舞台页:`setPlan` 收下的那份 K2 分派表(集合已回填)+ K1 的每卡记录,
     * 形状是 `src/render/wirePlan.ts` 的 `StagePlan`(这里写 `unknown` 是为了不给
     * kernel → render 再添一条反向边,见 `src/layering.test.mjs` 的白名单)。
     * 消费它的是 K3 / K5(R5);挂在这里给验收探针看「表到没到、算出来的是轻是重」。
     */
    __pcStagePlan?: () => unknown;
    /**
     * 舞台页:此刻的内部状态摊平(角色、节拍、四个集合、追帧任务、K6 的窗口)。
     * **只读、无副作用**,给验收探针用 —— 跨源摸不到 iframe 的 document,
     * 只能让舞台自己把状态交出来(形状写 `unknown`,理由同 `__pcStagePlan`)。
     */
    __pcStageDiag?: () => unknown;
    /** 舞台页:按 K2 的表查这一刻这个片段走哪条管线(`pipelineAt`)。没有表时一律 `'heavy'` */
    __pcStagePipelineAt?: (clipId: string, tSec: number) => 'light' | 'heavy';
    /**
     * 导出:DOM 变动次数。静态帧判定的主力 —— Motion 的 JS 动画绕开了被替换的 rAF,
     * 但它每帧都要把新值写回 style / 文本节点,这个躲不掉。理由详见 exportClock.ts。
     */
    __pcMutationCount?: number;
    /** 导出:这一帧画面静不静止(静止才敢复用上一帧的截图) */
    __pcStaticProbe?: () => { anims: number; finished: number; raf: number; mut: number; video: boolean; canvas: boolean };
    /** 导出:把 Math.random 的种子拨回起点(每次重挂载卡片时调),让随机效果可复现 */
    __pcResetRandom?: (seed?: number) => void;
    /** 导出:原地换项目,不重新导航。常驻预渲染进程复用同一个页面时用。 */
    __pcLoadProject?: (raw: unknown, options?: { deferCards?: boolean }) => Promise<void>;
    /** Restrict a sparse render to target-frame cards and seek before mounting. */
    __pcSetFrameWindow?: (clipIds: string[] | null, startTime: number, directTime?: number) => void;
    __pcPlanFrameWindow?: (frames: number[], fps: number) => import('../render/frameWindow.mjs').FrameWindow;
    /** Parallel export: every card clip with its frame mode, for choosing safe shard cuts. */
    __pcClipFrameModes?: () => { id: string; start: number; end: number; mode: string | undefined }[];
    /** 导出:把素材层的 src 摘掉(推进动画的过程中不加载任何素材) */
    __pcHideFrameMedia?: () => void;
    /** 导出:按 data-pc-media-* 把这一帧的素材装回来并 seek 到位 */
    __pcPrepareFrameMedia?: () => Promise<void>;
    /** 导出:排空挂着的宏任务,直到 DOM 不再变(见 render/snapshotSettle.ts) */
    __bfSettle?: () => Promise<void>;
    /** 导出 / 舞台:把此刻的 [data-pc-scene] 生成一份自给自足的 HTML 快照(见 render/createSnapshot.ts) */
    __pcCreateSnapshot?: () => import('../render/createSnapshot').SceneSnapshot;
  }
}

export function isExportMode(): boolean {
  return typeof window.__pcExportMs === "number";
}

export function clockNow(): number {
  const t = window.__pcExportMs;
  return typeof t === "number" ? t : performance.now();
}
