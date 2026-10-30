import { useEffect, useMemo, useRef, useState } from "react";
import { planBakes, defaultBudgetBytes, type BakeMoment, type BakeTier } from "./bakePlan";
import { clipFingerprint, momentId, publishCoverage, type ClipCoverage } from "./bakeCoverage";
import { isScrubbing } from "../timeline/useScrub";
import { prerenderUrl } from "../../render/prerender";

/**
 * 空闲时把贴图预先渲好。排队规则见 bakePlan.ts,这里只管**什么时候动手**。
 *
 * # 三条不能破的规矩
 *
 * 1. **不跟用户抢。** 预渲染一张要起一个 Chrome、四五秒,而且服务端那条渲染路是**串行**的
 *    (enqueue)。所以用户正在看的那张要是排在预渲染后面,就得干等 —— 本来是来提速的,
 *    反而卡了一下。于是:只在浏览器空闲时发,而且前台一有渲染请求就立刻让路(见下面那道闸)。
 * 2. **一次只渲一张。** 并发发过去也是在服务端排队,只会让「让路」变得不可能。
 * 3. **拖动时不动手。** 拖进度条会连续改 t,每一格都重排一次队没有意义。
 *    等它停下来一会儿再说(IDLE_MS)。
 *
 * # 为什么盘点要问服务端
 *
 * 缓存记在服务端(字节在素材服务的 `px` 里,「输入哈希 → 内容哈希」在预渲染一侧的小索引里,见 server/bake-store.mjs),
 * 浏览器关一次页面就全忘了 —— 上次开编辑器预渲染出来的,前端一个都不认识。
 * 所以每轮先问一次 /api/vision/bake-status:哪些已经有了、各自多大、还有哪些是没人认领的旧快照。
 * 不问的话占用永远算不准。
 *
 * 顺带解决了另一件事:**键只认服务端算的那一个**。预渲染、盘点、清理三方共用 `bakeTarget`,
 * 前端不自己算一套 —— 两处各算各的,迟早会「明明预渲染过却当成没渲」,而且不报错。
 *
 * # 预渲染哪几个时刻不由这里决定
 *
 * 一张卡在它那几秒里是会动的,要渲的是**若干个时刻**;挑哪几个是 `bakeTime.ts` 的事,
 * 由调用方算好了传进来。这里只管「什么时候动手」和「按什么顺序、留多少」。
 */

/** 用户停手多久算「空闲」 */
const IDLE_MS = 600;
/** 一轮做完歇多久再盘点下一轮 —— 别把服务端和磁盘一直吵醒 */
const REST_MS = 4000;
/**
 * 没活干的时候歇多久。
 *
 * 全渲完之后如果还按 REST_MS 去问,就是**每 4 秒列一次目录、stat 上百个文件,一直到关页面为止**。
 * 实测就是这样:界面上什么都没发生,网络面板里 bake-status 一条接一条。
 * 所以没活干就逐次翻倍往后退,退到一分钟一次;用户一改东西立刻退回 REST_MS(见 backoff 的重置)。
 */
const IDLE_MAX_MS = 60000;

/**
 * 前台渲染的让路闸。
 *
 * 3D 视图看到缺贴图会自己发一次渲染请求(那是用户正盯着的),
 * 而服务端渲染是串行的。前台开工前后各调一次,预渲染就会停下来等它。
 */
let foreground = 0;
export function beginForegroundBake() { foreground++; }
export function endForegroundBake() { foreground = Math.max(0, foreground - 1); }

/** 要预渲染的一个时刻。哪几个时刻由调用方挑(见 bakeTime.ts 的 sampleTimesFor) */
export interface WantedMoment {
  clipId: string;
  t: number;
  start: number;
  end: number;
  /** 低帧率还是原始帧率。不写按低帧率算 */
  tier?: BakeTier;
  /** 这一刻是否落在**原始帧率**的格子上(0.5 秒这种点两档都有,所以和 tier 是两件事) */
  fine?: boolean;
}

export interface PrefetchStatus {
  /**
   * 已经渲好的:`<clipId>@<t>` → 贴图 URL。
   * 键带上时刻,因为同一张卡会渲好几个时刻,只按 clipId 存会互相覆盖。
   */
  ready: Map<string, string>;
  /** 已经渲好的文件一共占多少磁盘(实测字节) */
  footprintBytes: number;
  budgetBytes: number;
  fileCount: number;
  /** 正在渲的那张(给状态条显示) */
  baking: { clipId: string; phase: string } | null;
  /** 还排着多少张 */
  queued: number;
  /** 这一轮删掉了几个过期文件 */
  evicted: number;
  error: string | null;
}

const EMPTY: PrefetchStatus = {
  ready: new Map(), footprintBytes: 0, budgetBytes: 0, fileCount: 0,
  baking: null, queued: 0, evicted: 0, error: null,
};

/** 浏览器空闲时回调;没有 requestIdleCallback 的就退化成一个短 timeout */
function onIdle(fn: () => void, timeout = 2000): () => void {
  const ric = (globalThis as any).requestIdleCallback;
  if (typeof ric === "function") {
    const id = ric(fn, { timeout });
    return () => (globalThis as any).cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, 200);
  return () => clearTimeout(id);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// momentId 定义在 bakeCoverage.ts(纯的,覆盖表也按它记账);这里再导出给 Scene3DView 用
export { momentId } from "./bakeCoverage";

// canonFrameT 定义在 bakePlan.ts(纯函数、可单测);这里再导出,方便 Scene3DView 一处引入
export { canonFrameT } from "./bakePlan";

export function useBakePrefetch({
  project,
  t,
  moments,
  enabled,
  budgetBytes,
}: {
  project: any;
  t: number;
  /** 整条片子要预渲染的所有时刻。调用方算好传进来(bakeTime.ts 的 sampleTimesFor) */
  moments: WantedMoment[];
  enabled: boolean;
  budgetBytes?: number;
}): PrefetchStatus {
  const [status, setStatus] = useState<PrefetchStatus>(EMPTY);
  /*
   * project / t / moments 走 ref:它们每拖一下都在变,进 effect 依赖会让整轮调度不停重启,
   * 结果就是永远停在「盘点」那一步,一张也渲不出来。
   * effect 只认 enabled,循环里每次都读最新值。
   */
  const projRef = useRef(project);
  projRef.current = project;
  const tRef = useRef(t);
  tRef.current = t;
  const momentsRef = useRef(moments);
  momentsRef.current = moments;
  /**
   * 每张卡当前的内容指纹。发布覆盖时要带上它 —— 画条子的那一侧靠它判断
   * 「这段覆盖还算不算数」,从而做到改完卡片当帧就变白,不用等这里发布。
   */
  const fingerprints = useMemo(() => {
    const m = new Map<string, string>();
    for (const tr of project?.tracks ?? []) for (const c of tr.clips ?? []) m.set(c.id, clipFingerprint(c));
    return m;
  }, [project]);
  const fpRef = useRef(fingerprints);
  fpRef.current = fingerprints;
  /** 最后一次改动的时刻 —— 用来判断用户是不是还在拖 */
  const touchedAt = useRef(Date.now());
  useEffect(() => { touchedAt.current = Date.now(); }, [project, t]);

  const budget = budgetBytes ?? defaultBudgetBytes((navigator as any)?.deviceMemory);

  useEffect(() => {
    if (!enabled) { setStatus(EMPTY); return; }
    let dead = false;
    let cancelIdle: (() => void) | null = null;
    const ready = new Map<string, string>();
    /** 这一刻正在渲(给绿条标出来)。渲完置回 null */
    let latestBakingAt: number | null = null;

    /** 等到「浏览器空闲」且「用户停手」且「前台没在渲」 */
    const waitIdle = () => new Promise<void>((resolve) => {
      const attempt = () => {
        if (dead) return resolve();
        // 手还按在播放头上就一律不动手 —— 拖动时每一格都会改 t,渲出来的全是一闪而过的位置
        const quiet = Date.now() - touchedAt.current >= IDLE_MS && !isScrubbing();
        if (quiet && foreground === 0) return resolve();
        cancelIdle = onIdle(attempt);
      };
      cancelIdle = onIdle(attempt);
    });

    /**
     * 把覆盖情况发给绿条。`bakingAt` 从 `latestBakingAt` 读 —— 它在渲的过程中会变,
     * 而这个函数在每轮盘点后调一次,不能把当时那个瞬间的值封进闭包。
     */
    const publishBaked = (all: BakeMoment[], known: Map<string, number>, fpAtRequest: Map<string, string>) => {
      let bytes = 0;
      for (const b of known.values()) bytes += b;
      const isBaked = (m: { key?: string }) => !!m.key && known.has(m.key);

      /*
       * **按卡分开发布**,每条带上这张卡当时的内容指纹。
       *
       * 合成一整条的话,就只有这个循环能更新它 —— 而这个循环要等当前这批渲完、
       * 再盘点一次才轮得到发布,于是「改完卡片条子纹丝不动」。分卡存之后,
       * 画条子的那一侧拿当前项目的指纹一对就知道哪条作废了,不用等这里。
       */
      const byClip = new Map<string, BakeMoment[]>();
      for (const m of all) {
        const list = byClip.get(m.clipId);
        if (list) list.push(m);
        else byClip.set(m.clipId, [m]);
      }

      const clips: ClipCoverage[] = [];
      const baked = new Set<string>();
      for (const [clipId, ms] of byClip) {
        /*
         * 用**发请求那一刻**的指纹,不是现在的。
         *
         * 盘点是异步的:请求发出去之后用户可能已经改了这张卡。拿"现在的指纹"去盖一份
         * "改之前的盘点结果",等于把过期数据盖上有效的戳 —— 实测过:改完 29ms 条子正确变白,
         * 591ms 那个在途的盘点回来,又把它涂回去了,而那一刻它根本还没重渲。
         * 条子说有、拖过去要等五秒,正是最不能接受的那种骗人。
         *
         * 带上当时的指纹之后,这种过期结果和当前项目对不上,画条子那一侧自动滤掉。
         */
        const fp = fpAtRequest.get(clipId);
        // 指纹都拿不到说明这张卡当时就不在项目里,那它的覆盖也没有意义
        if (!fp) continue;
        clips.push({
          clipId,
          fp,
          // 发布这一刻它待在哪儿。之后用户把卡挪走,画条子那侧按差值平移(见 ClipCoverage.start)
          start: ms[0]?.start ?? 0,
          moments: ms.map((m) => ({
            clipId: m.clipId, id: momentId(m.clipId, m.t), key: m.key,
            t: m.t, start: m.start, end: m.end, tier: m.tier, fine: m.fine,
          })),
        });
        // 盘点问回来「这个键在磁盘上」的,就是已经渲好的那些时刻
        for (const m of ms) if (isBaked(m)) baked.add(momentId(m.clipId, m.t));
      }
      publishCoverage({ clips, baked, bakingAt: latestBakingAt, bytes });
    };

    const post = async (url: string, payload: unknown, signal?: AbortSignal) => {
      /*
       * 预渲染挂得久、一次两批,发到**预渲染进程的源**上,不占编辑器自己那个源的连接
       * (浏览器同源只给约 6 条;挤满了编辑器要的模块、素材、接口全都得排队,见 src/render/prerender.ts)。
       */
      const res = await fetch(await prerenderUrl(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `${url} 失败(HTTP ${res.status})`);
      return data;
    };

    /** 没活干就往后退,有活干或用户动了就退回最短 */
    let backoff = REST_MS;

    /**
     * 歇着,但**用户一动就立刻醒**。
     *
     * 原来这里是一句 `await sleep(backoff)`,而 backoff 全渲完之后会翻倍到 60 秒。
     * 后果:改一张卡的参数 —— 它那几段缓存当场作废 —— 而进度条上的黄绿条还挂着,
     * 板子上还贴着改之前的图,**最长要等一分钟**才刷新。用户看到的就是"改了没反应"。
     *
     * 所以拆成小段睡,每段之间看一眼 touchedAt(改项目、拖播放头都会更新它)。
     * 250ms 一次的开销可以忽略:只是比一下时间戳,不发请求也不碰磁盘。
     */
    const restUntilTouched = async (ms: number) => {
      const since = touchedAt.current;
      const until = Date.now() + ms;
      while (!dead && Date.now() < until) {
        if (touchedAt.current !== since) return;
        await sleep(Math.min(250, ms));
      }
    };

    (async () => {
      while (!dead) {
        let didSomething = false;
        const roundStartedAt = touchedAt.current;
        try {
          await waitIdle();
          if (dead) return;

          const proj = projRef.current;
          const now = tRef.current;
          const wanted = momentsRef.current;
          if (!wanted.length) { await restUntilTouched(backoff); backoff = Math.min(IDLE_MAX_MS, backoff * 2); continue; }

          // 拍下**这一刻**每张卡长什么样。盘点是异步的,回来时项目可能已经变了(见 publishBaked)
          const fpAtRequest = fpRef.current;
          /* ① 盘点:哪些已经有了、各自多大、还有哪些没人认领 */
          const st = await post("/api/vision/bake-status", {
            project: proj,
            clips: wanted.map((m) => ({ clipId: m.clipId, t: m.t })),
            size: 1024,
          });
          if (dead) return;

          /*
           * 键一律用服务端算的那个(bakeTarget)。前端不自己算一套 ——
           * 两处各算各的,迟早会「明明预渲染过却当成没渲」,而且不报错,只是白白多等五秒。
           * 盘点是按 (clipId, t) 一一对应回来的,所以顺序就是 wanted 的顺序。
           */
          const known = new Map<string, number>();
          const planMoments: BakeMoment[] = [];
          for (const it of st.items ?? []) {
            // 渲不了的(素材段之类)服务端会带 error 回来,跳过,别一直重试
            if (!it.key) continue;
            const w = wanted.find((m) => m.clipId === it.clipId && m.t === it.t);
            if (!w) continue;
            /*
             * **tier 必须带过来。** 漏掉它的后果是所有时刻都退回 coarse:
             * 界面上显示"低帧率 23/496、原始帧率 0/0",而排队也就没有了先后 ——
             * 而且不报错,只是两档悄悄合成了一档。
             */
            planMoments.push({ clipId: w.clipId, t: w.t, start: w.start, end: w.end, key: it.key, tier: w.tier ?? "coarse", fine: !!w.fine });
            if (typeof it.bytes === "number") {
              known.set(it.key, it.bytes);
              if (it.url) ready.set(momentId(w.clipId, w.t), it.url);
            }
          }
          // 没人认领的旧文件也计入占用 —— 不数它们的话,磁盘上的东西永远删不掉
          for (const o of st.orphans ?? []) known.set(o.key, o.bytes);

          /*
           * 把「哪几段已经能立刻看到画面」发给时间轴顶上那条绿条。
           *
           * 用**这一轮盘点的结果**发,而不是用前端记的那份:盘点是问服务端要的,
           * 上次开编辑器预渲染出来的文件也算数;只按这次会话渲过的算,绿条会从零开始涨,
           * 明明磁盘上早就有了。
           */
          publishBaked(planMoments, known, fpAtRequest);

          /* ② 排队:眼前 → 两侧 → 从 0 铺;同一份名单顺便算出该删哪些 */
          const plan = planBakes({ moments: planMoments, t: now, budgetBytes: budget, known });

          /* ③ 先删再渲:腾出来的空间这一轮就能用上 */
          let evicted = 0;
          if (plan.evict.length) {
            // 键全是服务端给的,它那边还会再拿自己的索引比对一次,删的只是索引条目(字节留在素材服务里)
            const gone = await post("/api/vision/bake-evict", { keys: plan.evict });
            evicted = gone.deleted?.length ?? 0;
            for (const k of gone.deleted ?? []) known.delete(k);
            if (evicted) didSomething = true;
          }
          if (dead) return;

          let footprint = plan.footprintBytes;
          setStatus({
            ready: new Map(ready), footprintBytes: footprint, budgetBytes: budget,
            fileCount: st.fileCount ?? 0, baking: null, queued: plan.jobs.length, evicted, error: null,
          });

          /*
           * ④ **一批一批渲**,每批填满服务端的渲染池。
           *
           * 以前是一张一张发的,而服务端一次能并行跑好几个(28 核的机器上是 7 个)——
           * 一张一张发等于让池子空着 6 个槽位干等。批的大小跟着服务端报的 concurrency 走,
           * 别在前端猜:那个数是按机器的核心数和空闲内存算的,只有服务端知道。
           *
           * 批不宜再大:一批发出去就不能中途改主意了,而用户随时可能拖走 ——
           * 刚好填满池子,既不浪费槽位,也不会让「回去重排」等太久。
           */
          const lot = Math.max(1, Math.min(8, Number(st.concurrency) || 1));
          /**
           * 同时挂几个请求在飞。
           *
           * **一批刚好填满池子,不等于池子一直是满的。** 一批里那几张卡的活儿长短差很多
           * (预渲染一张卡要从第 0 帧顺推到它所在的帧,所以贵在它排在时间轴多靠后,和它自己
           * 长不长没关系)。一个请求要等**最慢的那张**才返回,于是每批的尾巴上池子都在塌:
           * 先渲完的那几个槽位空着,干等最后一张。批越大,尾巴越长。
           *
           * 所以同时挂两批:A 收尾的时候 B 的活已经在池子里了,槽位不落空。
           *
           * 为什么是 2 而不是更多:浏览器对同一个源只给约 6 条 HTTP/1.1 连接,而**贴图本身
           * 也要走这些连接**取回来。Scene3DView 那边踩过一次:挂了 4 个渲染请求之后,
           * 连取一张已经渲好的图的 GET 都排不进去,表现成「拖回已经预渲染过的地方也不刷新」。
           * 两批(前台那张再占一条)还剩三条给图,够用。
           */
          const INFLIGHT = 2;
          /**
           * 一趟最多捎多少个同卡时刻。**顺路的那部分几乎免费**:服务端从第 0 帧顺推,
           * 「渲第 F 帧」已经把 0..F 推了一遍,同一张卡其余 ≤F 的时刻只多花一次截图(约 78ms),
           * 而单独开一趟要 4400ms。封顶是怕一个请求跑太久 —— 用户拖走时掐掉的那一趟越长越亏
           * (虽然不浪费:服务端照样落盘)。
           */
          const RIDE_ALONG = 48;
          const taken = new Set<number>();
          let done = 0;
          /** 已经发出去、还没回来的那几批。`at` 是这一批里最靠前的时刻(绿条要标它) */
          const flying = new Set<{ at: number; p: Promise<void> }>();
          /** 在飞的批里最靠前的那一刻 —— 绿条标的是它,不是某一批自己的 */
          const bakingAtNow = () => (flying.size ? Math.min(...[...flying].map((f) => f.at)) : null);

          /** 发一批出去,登记进 flying;回来时自己摘掉、更新绿条 */
          const launch = (batch: typeof plan.jobs) => {
            const entry = { at: Math.min(...batch.map((j) => j.t)), p: Promise.resolve() };
            // 先登记再开跑:反过来的话 finally 里那句 delete 有可能先于 add 执行
            flying.add(entry);
            latestBakingAt = bakingAtNow();
            publishBaked(planMoments, known, fpAtRequest);
            setStatus((s) => ({
              ...s, baking: { clipId: batch[0].clipId, phase: batch[0].phase },
              queued: Math.max(0, plan.jobs.length - done),
            }));
            entry.p = (async () => {
              try {
                /*
                 * 用户一动就把这批掐掉。实测:不掐的话「改完一张卡到进度条更新」要 11.8 秒,
                 * 其中 7.8 秒是干等这批渲完 —— 而这批渲的还是**改之前**那一版,早就作废了。
                 *
                 * 掐掉不浪费:服务端不会因此停手,图照样落盘(见 bakeOne 的 bakeInFlight),
                 * 只是这一轮不再等它。
                 */
                const ac = new AbortController();
                const stopWatch = (async () => {
                  while (!ac.signal.aborted && !dead) {
                    if (touchedAt.current !== roundStartedAt) return ac.abort();
                    await sleep(200);
                  }
                })();
                const out = await post("/api/vision/bake-batch", {
                  project: projRef.current,
                  clips: batch.map((j) => ({ clipId: j.clipId, t: j.t })),
                  size: 1024,
                }, ac.signal).finally(() => { ac.abort(); void stopWatch; });
                for (const b of out.baked ?? []) {
                  /*
                   * 按「卡 + 时刻」存,而且时刻用**服务端回的那个**:一批里有好几张,
                   * 拿 batch[0] 的 t 去认会把整批都记成同一刻(而且不报错,只是贴图对不上)。
                   */
                  ready.set(momentId(b.clipId, b.t), b.url);
                  if (typeof b.bytes === "number") footprint += b.bytes;
                  // 这一刻已经能看了,记进 known,下一句发布时绿条就把它涂上
                  const j = batch.find((x) => x.clipId === b.clipId && x.t === b.t);
                  if (j && typeof b.bytes === "number") known.set(j.key, b.bytes);
                }
              } catch (e: any) {
                // 一批渲不出来不该让整轮停摆,下一轮盘点会重新遇到它们;
                // 被掐掉的更不算错 —— 那是项目变了、我们自己主动放弃的
                if (!dead && e?.name !== "AbortError") setStatus((s) => ({ ...s, error: String(e?.message || e) }));
              } finally {
                flying.delete(entry);
                done += batch.length;
                latestBakingAt = bakingAtNow();
                // 每回来一批就更新绿条,而不是等整轮跑完 —— 用户要看着它一段一段长出来
                publishBaked(planMoments, known, fpAtRequest);
                setStatus((s) => ({
                  ...s,
                  ready: new Map(ready),
                  footprintBytes: footprint,
                  baking: flying.size ? s.baking : null,
                  queued: Math.max(0, plan.jobs.length - done),
                }));
              }
            })();
          };
          for (let i = 0; i < plan.jobs.length; i += 1) {
            if (taken.has(i)) continue;
            /*
             * **批次的先后一点没动**:仍然按 plan.jobs 的顺序(离播放头由近到远)取下一个还没发的活,
             * 填满服务端的池子。变的只是「每张卡把自己其余的时刻捎上」—— 那部分是顺路的。
             */
            const batch: typeof plan.jobs = [];
            const clipsIn = new Set<string>();
            for (let k = i; k < plan.jobs.length && clipsIn.size < lot; k++) {
              if (taken.has(k)) continue;
              const j = plan.jobs[k];
              if (!clipsIn.has(j.clipId)) {
                if (clipsIn.size >= lot) break;
                clipsIn.add(j.clipId);
              }
              taken.add(k); batch.push(j);
            }
            // 再把这几张卡在队伍里更靠后的时刻捎上,按卡各自封顶
            const perClip = new Map<string, number>();
            for (const j of batch) perClip.set(j.clipId, (perClip.get(j.clipId) ?? 0) + 1);
            for (let k = 0; k < plan.jobs.length; k++) {
              if (taken.has(k)) continue;
              const j = plan.jobs[k];
              if (!clipsIn.has(j.clipId)) continue;
              const n = perClip.get(j.clipId) ?? 0;
              if (n >= RIDE_ALONG) continue;
              perClip.set(j.clipId, n + 1);
              taken.add(k); batch.push(j);
            }
            if (dead) return;
            /*
             * 满了就停。**最多超出还在飞的那几批**(几十 KB × INFLIGHT)—— 因为没渲出来之前
             * 不知道它多大,而为了这几十 KB 去估一个大小,反而会把整套东西建在猜测上。
             */
            if (footprint >= budget) break;
            await waitIdle();
            if (dead) return;
            /*
             * 用户在这一轮开始之后动过任何东西 → 手上这份队伍已经不作数了,回去重排。
             *
             * 原来这里写的是 `Date.now() - touchedAt.current < IDLE_MS`,**永远不成立**:
             * 上面那句 `waitIdle()` 的定义就是"安静满 IDLE_MS 才返回",所以走到这一行时
             * 这个差值必然 ≥ IDLE_MS。等于这条退出路径从来没生效过。
             *
             * 后果实测得到:一轮排出四百多个活,每批 7 个约 5 秒 —— 整整五分钟里
             * **一次都不会重新盘点**。期间改一张卡,进度条上它那几段黄绿条纹丝不动,
             * 因为重新发布覆盖只发生在下一轮盘点之后。用户看到的就是"改了半天没反应"。
             *
             * 比时间戳而不是比时长:只要和开工时不一样,就说明中途有变化。
             */
            if (touchedAt.current !== roundStartedAt) break;

            didSomething = true;
            /*
             * 池子里没位置就等一个回来。**只等一个,不等全部** —— 等全部就退回原来那种
             * 「一批一批地等最慢的」,尾巴照样塌。
             */
            if (flying.size >= INFLIGHT) await Promise.race([...flying].map((f) => f.p));
            if (dead) return;
            if (touchedAt.current !== roundStartedAt) break;
            launch(batch);
          }
          /*
           * 这一轮的活全排出去了,等挂着的那几批回来再进下一轮盘点。
           * 不等的话下一轮会拿着「还没落盘」的盘点结果重排一遍,把正在渲的那些又排一次。
           */
          await Promise.allSettled([...flying].map((f) => f.p));
        } catch (e: any) {
          if (!dead) setStatus((s) => ({ ...s, baking: null, error: String(e?.message || e) }));
        }
        /*
         * 这一轮干了活,或者用户在这期间动过东西 → 下一轮马上来;
         * 否则说明已经渲齐了,逐次翻倍往后退,免得空转着一直问服务端。
         */
        /*
         * 因为**有变化**才回到这里的:立刻重排,别再歇。手上这份计划已经作废了,
         * 歇 4 秒只是让用户多盯 4 秒不对的进度条。下一轮开头的 waitIdle 会保证
         * 「安静 600ms」,连续编辑自然会被合并,不会打成一片请求。
         */
        const changed = touchedAt.current !== roundStartedAt;
        backoff = changed ? 0 : didSomething ? REST_MS : Math.min(IDLE_MAX_MS, backoff * 2);
        if (backoff > 0) await restUntilTouched(backoff);
      }
    })();

    return () => { dead = true; cancelIdle?.(); };
  }, [enabled, budget]);

  return status;
}
