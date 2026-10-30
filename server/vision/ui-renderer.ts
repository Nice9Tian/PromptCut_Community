/**
 * 编辑器这一端常驻的那对热备渲染器(A / B)。从 server/vite-plugin-vision.ts 逐字搬来。
 *
 * 状态全在 `createUiRenderer` 的闭包里(slots / running / pending),没有模块级可变状态;
 * 唯一写到别处的是 worker 池的 `lastRenderOrigin`,走 `setLastRenderOrigin`。
 * 依赖方向:ui-renderer → worker-pool → render-queue,单向。
 */
import { cancelError } from "./render-queue";
import { runOnWorker, setLastRenderOrigin, spawnWorker } from "./worker-pool";
import type { RenderWorker, RenderJob2, Runner } from "./worker-pool";

/*
 * ===================== 编辑器这一端:常驻热备渲染器(A / B) =====================
 *
 * 用户的前台渲染(3D 视图当前时刻的贴图、拖动播放头时要的那一帧)**不进预渲染池**,由编辑器
 * 自己守着的两台 Chrome 专门处理(docs/archive/topics/decoupling-plan.md 第 3.2 节「交互界面」)。原话:
 * 「交互端需要留两个 chrome 渲染,永远保持一个是热状态……A 正在渲染,这时候接到了新的任务,
 * 立刻交给热状态的 B,同时清空 A,之后 B 在渲染,A 热状态待机」。
 *
 * 为什么要两台:一台 Chrome 被打断之后要换一张新页才能再用(约 310 ms,冷启动 5.6 s,
 * 往就绪的空页里灌项目只要 3~4 ms,见 hybrid-sampling-plan.md E0)。两台轮换,新请求永远落在热的
 * 那台上,换页的钱放到后台去付。两台是两个独立进程:一台崩了另一台照样顶着。
 *
 * 调度规则:
 *   1. 有热的(或至少空着的)那台就交给它;
 *   2. 两台都在忙:正在渲的那台如果才做了一小段(< UI_INTERRUPT_MS)就打断它,腾出来接新的;
 *      做了不少就让它渲完 —— 结果照样进缓存(bakeOne 落盘),拖回去直接命中;
 *   3. 两台都腾不出来:新请求进「待办」,只留最新一个,先来的直接回「被新请求替换」;
 *   4. 第 2 条的门槛必不可少:拖动播放头每秒几十个请求,每来一个都打断的话,两台会一直在
 *      「打断 → 换页」之间来回,一张图都出不来。
 * 请求方断开也按第 2 条判:才开始的就停,做了不少的渲完进缓存。
 */

/** 正在渲的那一趟做了多久以内才允许打断(毫秒,估计值,按实测再调) */
const UI_INTERRUPT_MS = 150;

interface UiRequest {
  job: RenderJob2;
  signal?: AbortSignal;
  resolve: (v: any[] | null) => void;
  reject: (e: Error) => void;
  /** 已经换一台重试过一次(非取消的失败只重试一次) */
  retried?: boolean;
}

export function createUiRenderer(root: string, originFn: () => string) {
  const slots: RenderWorker[] = [];
  const running = new Map<RenderWorker, { ac: AbortController; startedAt: number }>();
  let pending: UiRequest | null = null;

  const ensure = () => {
    for (let i = slots.length - 1; i >= 0; i--) if (slots[i].dead) slots.splice(i, 1);
    while (slots.length < 2) {
      // 预热要一个能打开的导出页地址:就是编辑器自己的源
      setLastRenderOrigin(originFn());
      const w = spawnWorker(root, true);
      w.onHot = () => dispatch();
      slots.push(w);
    }
  };

  /*
   * **巡检:永远保持热着**(用户原话「永远保持一个是热状态,才能随时响应」)。
   *
   * 「热」靠 worker 报 hot 维持,但有几种情形它不会再报:活失败后 worker 丢了浏览器(bakery 为空,
   * 不会自己重开);卡片连着改几次,备用页被扔了又开、中途开失败。实测完整跑一遍端到端之后,
   * 两台都停在「空闲、不热」,最后一次 hot 在 45 秒前。
   * 每 2 秒看一眼:空闲却不热的那台发一次预热(没浏览器就开一个,有就换页、备好备用页,好了会报 hot)。
   * 同一台 5 秒内不重复催。热着的时候什么都不做,不花钱。
   */
  const keepWarm = setInterval(() => {
    const now = Date.now();
    for (const w of slots) {
      if (w.dead || w.busy || w.hot) continue;
      if (w.warmingAt && now - w.warmingAt < 5000) continue;
      w.warmingAt = now;
      try { w.child.send({ type: "prewarm", url: `${originFn()}/?export=1` }, () => {}); } catch { /* 送不到的下一轮 ensure 会换掉 */ }
    }
  }, 2000);
  keepWarm.unref?.();

  /** 挑一台:热的优先,其次空着的(还在换页 / 刚起的也行,worker 里会等备用页就绪) */
  const freeSlot = () => slots.find((w) => !w.dead && !w.busy && w.hot) ?? slots.find((w) => !w.dead && !w.busy);

  const start = (w: RenderWorker, req: UiRequest) => {
    const ac = new AbortController();
    const startedAt = Date.now();
    // 请求方断开:才开始的就停;做了不少的让它渲完,结果进缓存
    const onOuter = () => { if (Date.now() - startedAt < UI_INTERRUPT_MS) ac.abort(); };
    req.signal?.addEventListener("abort", onOuter, { once: true });
    w.busy = true;
    running.set(w, { ac, startedAt });
    runOnWorker(w, req.job, ac.signal)
      .then(req.resolve, (e: any) => {
        /*
         * 不是被取消、也没被请求方放弃的失败,换一台再试一次。实测连着打断、换页时偶尔会撞上
         * 「Browser target is not found」(这台背后的浏览器没了;worker 已经把它丢掉,巡检几秒内重开)。
         * 用户正盯着这张图,别让这种一次性的失败漏到界面上。只重试一次,第二次还失败就如实报。
         */
        if (!e?.cancelled && !req.retried && !req.signal?.aborted) {
          // 带着 retried 重新交进去:第二次再失败就走下面的 reject,不会一直重试下去
          submit({ ...req, retried: true });
          return;
        }
        req.reject(e);
      })
      .finally(() => {
        running.delete(w);
        req.signal?.removeEventListener("abort", onOuter);
        dispatch();
      });
  };

  const dispatch = () => {
    if (!pending) return;
    ensure();
    const w = freeSlot();
    if (!w) return;
    const req = pending;
    pending = null;
    start(w, req);
  };

  /** 交一个请求进来:有空的就跑,否则按规则 2 / 3 打断或排进待办。重试也走这里(带着 retried) */
  const submit = (req: UiRequest) => {
    ensure();
    if (req.signal?.aborted) return req.reject(cancelError());
    const w = freeSlot();
    if (w) return start(w, req);
    // 规则 2:打断一台才开始的
    for (const [, r] of running) {
      if (Date.now() - r.startedAt < UI_INTERRUPT_MS) { r.ac.abort(); break; }
    }
    // 规则 3:只留最新的一个
    if (pending) pending.reject(Object.assign(new Error("被更新的请求替换了"), { cancelled: true }));
    pending = req;
    req.signal?.addEventListener("abort", () => {
      if (pending !== req) return;
      pending = null;
      req.reject(cancelError());
    }, { once: true });
  };

  const run: Runner = (job, signal) => new Promise((resolve, reject) => submit({ job, signal, resolve, reject }));

  return {
    run,
    prewarm: ensure,
    /** 服务关掉时停掉巡检(vite 在同一个进程里重启时,旧的这一份不该还在往死掉的 worker 发消息) */
    stop: () => clearInterval(keepWarm),
    status: () => ({
      workers: slots.filter((w) => !w.dead).length,
      hot: slots.filter((w) => !w.dead && w.hot && !w.busy).length,
      busy: slots.filter((w) => !w.dead && w.busy).length,
      pending: pending ? 1 : 0,
      // 每台的明细:排查「热」为什么没回来时看它
      detail: slots.map((w) => ({
        pid: w.child.pid, dead: w.dead, hot: w.hot, busy: w.busy, hotPending: !!w.hotPending,
        hotMsgs: w.hotMsgs ?? 0, lastHotAgoMs: w.lastHotAt ? Date.now() - w.lastHotAt : null,
      })),
    }),
  };
}
