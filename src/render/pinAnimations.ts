/**
 * WAAPI / CSS 动画钉时间。
 *
 * 驱动式时钟能管住 Motion 的帧循环和卡片自己的 rAF,但管不到 CSS animation /
 * transition / WAAPI:它们跑在合成线程上,按浏览器自己的时钟走。
 * 做法和导出视图的 __pcSyncAnims 一样:记下每个动画头一次出现时的舞台时间当锚点,
 * 之后每帧把 currentTime 钉到「现在 − 锚点」并暂停,数值就只由时间决定,和机器快慢无关。
 * 前提是动画出生时就已经停在 0 —— 由 stageClock 装的 patchAnimate 保证。少了它,动画会按
 * document.timeline 的真实时间出生即 finished,下面那句「跳过 finished」就把整个入场跳掉了。
 *
 * # 三个按子树的口子(R3:K3 / K5)
 *
 * 舞台要按**片段**做三件事,全局的 `sync` / `reset` 太粗:
 *
 *   - `resetIn(el)`  重挂载一个片段前只丢它自己的锚点(整份 WeakMap 重建会把别的卡一起清掉,
 *                    它们的入场动画会在那一刻从头播一遍);
 *   - `syncIn(el, stageMs)` 只钉这个片段子树里的动画 —— K3(a′) 的 `seekOk` 一步定位、
 *                    K5 第一路的子树追帧都用它。**时间基一律是全局舞台毫秒**:喂本地毫秒
 *                    会让锚点落在本地基上,交回全局 `sync` 时 target 多出 `clip.start × 1000`,
 *                    一把 `finish()` 到终态;
 *   - `sync(nowMs, skip)` 全局钉,但跳过 `skip` 里那些包裹层子树的动画 —— 正在自己追帧
 *                    (`.pc-settling`)或被抑制(`.pc-suppressed`)的片段不能被全局时钟拨回去。
 *
 * # 结束回调当场交付
 *
 * 动画被拨到结尾时调的是 `finish()`。浏览器并不当场通知:「结束事件」排到这个文档**下一次真实出帧**时才派发,
 * 而舞台推帧不等真实的帧(后台舞台推帧时大约一秒才出一帧,补跑时帧与帧之间只让微任务,一帧都不出)。
 * Motion 靠这条动画的 `onfinish` 得知它播完了(写回终值、撤掉动画、通知等它的人),事件迟到多久,
 * 它对这条动画的认识就旧多久 —— 换词的卡(`AnimatePresence mode="wait"`)因此同一帧每次推出来的画面都不一样,
 * 别的卡留下「动画还挂着、终值没写回」的痕迹(实测与拆解见 `docs/reports/AGENT-rr-a1-verify.md`)。
 *
 * 所以这里不等浏览器:每次 `sync` / `syncIn` 把该钉的都钉完以后,**当场**把这一趟里拨到结尾的那些动画的
 * `onfinish` 调掉。动画什么时候算结束于是只由舞台时间决定,和浏览器出不出帧无关。
 *
 *   - 浏览器之后还会补发它自己的那一次结束事件。已经交付过的不能再调一遍(Motion 的回调会把终值再写一次,
 *     那时同一个属性上可能已经起了下一条动画),所以交付时把 `onfinish` 临时换成一个只吞这一次的占位,吞完换回原样。
 *   - 等全部钉完再交付:回调里会撤动画、改样式,不能夹在钉别的动画中间。
 *   - 只管用 `onfinish` 属性挂的回调(Motion 是这样挂的)。`finished` 这个 Promise 在 `finish()` 里就已经落定,
 *     本来就不等出帧。用 `addEventListener('finish')` 挂的监听、CSS 动画的 `animationend`、过渡的 `transitionend`
 *     仍然等浏览器出帧:当场补发这几种事件,浏览器自己那一次就没法只对已经收到的监听拦下。内置卡和 Motion 都不用它们。
 */
export interface AnimationPinner {
  /**
   * 每跑一帧调一次:nowMs = 当前舞台时间。
   * `skip`:这些包裹层(`[data-pc-clip]`)子树里的动画这一帧不钉(K5 第一路 / E7 第 5 条)。
   */
  sync(nowMs: number, skip?: ReadonlySet<Element>): void;
  /** 只钉 `el` 子树里的动画,时间基同样是**全局舞台毫秒**(K3(a′) / K5 第一路) */
  syncIn(el: AnimationHost | null | undefined, stageMs: number): void;
  /**
   * 最近一次 `sync` / `syncIn` 里被拨到结尾的动画数(它们的结束回调已经当场交付)。
   * 调用方据此知道这一帧要不要再等一次 React 提交(`StageView.tsx` 的 `bakeFrame`)。
   */
  endedInLastSync(): number;
  /** 重挂载卡片前调一次,丢掉旧锚点 */
  reset(): void;
  /** 只丢 `el` 子树里那些动画的锚点(按片段重挂载,K3),别的卡不动 */
  resetIn(el: AnimationHost | null | undefined): void;
}

/*
 * # 占位符的豁免
 *
 * 占位组件自己的 CSS 动画(`pc-ph-` 前缀,contract 的 `isPlaceholderAnimation`)管「来不及满 120 ms
 * 才显示」和沙漏转动,**按真实时间走**。钉住它的话暂停态虚拟时钟不动,占位符永远停在不可见的第 0 毫秒。
 * 所以整页 `sync` 和子树 `syncIn` 都跳过它;只认前缀,别的卡片动画一律照钉。
 */
import { isPlaceholderAnimation } from "./placeholder/contract.ts";

/** 能交出自己子树里那些动画的东西。真实场景里就是 `Element`;单测里给一个假的 */
export interface AnimationHost {
  getAnimations(options?: { subtree?: boolean }): Animation[];
}

/** 这条动画挂在哪个片段的包裹层上(找不到就是 null:不属于任何片段) */
function clipWrapperOf(a: Animation): Element | null {
  const target = (a.effect as KeyframeEffect | null)?.target ?? null;
  return target && typeof target.closest === "function" ? target.closest("[data-pc-clip]") : null;
}

type FinishHandler = NonNullable<Animation["onfinish"]>;

/** 一条动画上「已经当场交付、浏览器还没补发」的结束事件:原来的回调、顶替它的占位、还欠几次 */
interface OwedFinish {
  handler: FinishHandler;
  guard: FinishHandler;
  count: number;
}

export function createAnimationPinner(doc: Document = document): AnimationPinner {
  let anchors = new WeakMap<Animation, number>();
  /** 这一趟里被拨到结尾的动画;钉完一起交付结束回调(见文件头「结束回调当场交付」) */
  let ended: Animation[] = [];
  const owed = new WeakMap<Animation, OwedFinish>();

  /** 当场调这条动画的 `onfinish`,并让浏览器之后补发的那一次落空 */
  const deliverFinish = (a: Animation): void => {
    let debt = owed.get(a);
    // 占位被别人换掉了(回调里自己改了 `onfinish`):旧账作废,按现在挂着的算
    if (debt && a.onfinish !== debt.guard) {
      owed.delete(a);
      debt = undefined;
    }
    const handler = debt ? debt.handler : a.onfinish;
    if (typeof handler !== "function") return;
    if (debt) debt.count++;
    else {
      const fresh: OwedFinish = {
        handler,
        count: 1,
        guard: () => {
          if (--fresh.count > 0) return;
          owed.delete(a);
          if (a.onfinish === fresh.guard) a.onfinish = fresh.handler;
        },
      };
      owed.set(a, fresh);
      a.onfinish = fresh.guard;
    }
    try {
      handler.call(a, new AnimationPlaybackEvent("finish", { currentTime: a.currentTime, timelineTime: a.timeline?.currentTime ?? null }));
    } catch (err) {
      console.error("[pinAnimations] 结束回调抛错", err);
    }
  };

  /** 最近一趟拨到结尾了几条(`endedInLastSync`) */
  let lastEnded = 0;

  /** 这一趟拨到结尾的动画,逐条交付结束回调 */
  const deliverEnded = (): void => {
    // 先取走再调:回调里再触发一次 sync 的话,新拨到结尾的归那一次
    const batch = ended;
    ended = [];
    lastEnded = batch.length;
    for (const a of batch) deliverFinish(a);
  };

  /** 把一条动画钉到 nowMs。返回 false 表示这条不用管(已经结束 / 还没开始) */
  const pin = (a: Animation, nowMs: number): void => {
    if (a.playState === "finished" || a.playState === "idle") return;
    if (isPlaceholderAnimation(a as Animation & { animationName?: string })) return;
    let anchor = anchors.get(a);
    if (anchor === undefined) {
      anchor = nowMs;
      anchors.set(a, anchor);
    }
    const target = Math.max(0, nowMs - anchor);
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end === "number" && Number.isFinite(end) && target >= end) {
      // 越过结尾:finish() 让 Motion 提交终态、CSS 动画回到自然样式,和正常播完一致。
      // Motion 的提交在它的结束回调里,这一趟钉完由 deliverEnded 当场调,不等浏览器出帧
      a.finish();
      ended.push(a);
      return;
    }
    if (a.playState !== "paused") a.pause();
    a.currentTime = target;
  };

  return {
    reset() {
      anchors = new WeakMap<Animation, number>();
    },
    resetIn(el) {
      if (!el) return;
      for (const a of el.getAnimations({ subtree: true })) anchors.delete(a);
    },
    sync(nowMs: number, skip?: ReadonlySet<Element>) {
      for (const a of doc.getAnimations()) {
        // 占位符自己的动画、已结束 / 未开始的先剔掉,别为它们往上找包裹层(P4 性能修正)
        if (a.playState === "finished" || a.playState === "idle") continue;
        if (isPlaceholderAnimation(a as Animation & { animationName?: string })) continue;
        /*
         * 正在自己追帧 / 被抑制的片段这一帧不钉。判据是「这条动画的目标元素往上最近的
         * [data-pc-clip] 在不在 skip 里」—— 不能按 target 本身查,卡片内部随便哪一层都能起动画。
         */
        if (skip?.size) {
          const wrap = clipWrapperOf(a);
          if (wrap && skip.has(wrap)) continue;
        }
        pin(a, nowMs);
      }
      deliverEnded();
    },
    syncIn(el, stageMs: number) {
      if (!el) return;
      for (const a of el.getAnimations({ subtree: true })) pin(a, stageMs);
      deliverEnded();
    },
    endedInLastSync: () => lastEnded,
  };
}
