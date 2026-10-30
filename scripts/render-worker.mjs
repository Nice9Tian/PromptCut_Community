import { openBakery, bakeFrames } from '../server/bakery/index.mjs';
import { postFrame } from '../server/png-post.mjs';

/**
 * 常驻渲染 worker:**一个进程守着一个 Chrome,一趟一趟接活**。
 *
 * # 为什么要有它
 *
 * 以前每渲一次就 spawn 一个 node、起一个 Chrome、goto 一次导出页,这笔钱是**固定的**:
 * 实测 `--frames 0-0`(起进程 + 起 Chrome + 加载页面 + 推第 0 帧 + 截 1 张)4211ms,
 * 其中推帧和截图加起来只占约 100ms。也就是说用户在 3D 视图里拖到一个新位置、
 * 板子还是色块的那几秒里,**四秒是在等一个浏览器开机**。
 *
 * 而 server/bakery 早就把「预渲染间」拆出来了(openBakery / bakery.reset / bakeFrames),
 * 并且验过复用的确定性:新开一个 page 是一个全新的 renderer,从没被启用过虚拟时间,
 * 和全新起一个浏览器等价 —— 见 openBakery 和 reset 的注释。这里只是把那套东西
 * 放进一个不退出的进程里。
 *
 * # 为什么用 IPC 而不是 stdin/stdout
 *
 * 预渲染过程本身往 stdout 写 `PAGE LOG:` 和进度,出错时父进程要拿最后几行当错误信息。
 * 再往同一条管子里塞协议消息,两边都得先猜「这一行是日志还是消息」。走 `process.send`
 * 是另一条通道,互不干扰。
 *
 * # 消息
 *
 *   prewarm    { url }            现在就起 Chrome、停在导出页上,别等活来了才开机
 *   bake       { id, opts }       渲一趟(server/bakery 的 bakeFrames)
 *   post       { id, items }      这一帧交出去之前的像素活(合成素材层、压底色、缩图),见 server/png-post.mjs。
 *                                 放在这里做,是为了不占父进程(给编辑器供模块的 Vite)的事件循环
 *   cancel     { id }             不要这一趟了。**只换页,不换浏览器**(见下面第 1 条的例外)
 *   invalidate {}                 卡片源码变了:备用页里加载的是旧模块,扔掉
 *
 * 回给父进程的:ready、started、done、error(被取消的带 cancelled: true)、hot(手上没活、备用页好了,
 * 下一趟来活只需把项目灌进去 —— 界面那对热备渲染器按它判断「谁是热的」)。
 *
 * # 三条自保规矩
 *
 * 1. **出过错的 bakery 一律丢掉。** 预渲染中途失败时页面可能挂着没排空的任务 —— 下一趟在这样的
 *    页面上接着渲,渲出来的东西不可信,而且**不报错**。所以宁可多付一次 3 秒的重开。
 *    例外是**取消**:它停在两帧之间(bakeFrames 每帧开头看一眼 signal),页面不在半路上,
 *    而下一趟本来就要换一张全新的页(resetWith),旧页随之关掉 —— 用不着重开浏览器。
 * 2. **渲够 MAX_JOBS 趟主动重开。** Chrome 长时间跑会慢慢涨内存(每趟一个新 renderer,
 *    旧的关掉但浏览器进程自己的堆不回落)。这台机器上多开 Chrome 踩过 0xC0000142,
 *    宁可定期换一个新的。
 * 3. **闲够 IDLE_EXIT_MS 就自己退。** 一个 worker 约 300~500MB,预渲染一停就是纯占着。
 *    退掉之后父进程下次要活时重新拉起来 —— 那时候用户已经在等了,但只等一次。
 */

/** 渲几趟就换一个新浏览器 */
const MAX_JOBS = Number(process.env.PROMPTCUT_WORKER_MAX_JOBS) || 40;
/**
 * 闲多久就自己退出(毫秒)。
 *
 * **传 0 = 永不退出**,留给前台专用的常驻 worker:它存在的全部意义就是「用户随时松手,
 * 都有一个热的 Chrome 立刻接住」,闲三分钟就退掉的话,用户去改了会儿参数再回来拖时间轴,
 * 又要等一次开机。
 */
const rawIdle = process.env.PROMPTCUT_WORKER_IDLE_MS;
const IDLE_EXIT_MS = rawIdle === undefined || rawIdle === "" ? 180000 : Number(rawIdle);

let bakery = null;
/** 这个 bakery 已经渲过几趟 */
let jobsDone = 0;
let idleTimer = null;
/** 正在跑的那一趟:取消消息靠 id 找到它的 AbortController */
let current = null;
/** 已经收到、还没做完的预渲染活(含排在本进程链上的)。只有它为 0 时才报 hot */
let jobsInHand = 0;
/** 还排在本进程链上、没开跑就被取消的活。只在手上还有活时才记,并且设上限,不会一直涨 */
const cancelledEarly = new Set();
const CANCELLED_EARLY_MAX = 200;
/** 最近一次用过的导出页地址:invalidate 之后按它重开备用页 */
let lastUrl = null;

function cancelledError() {
  return Object.assign(new Error('已取消'), { cancelled: true });
}

function armIdleExit() {
  clearTimeout(idleTimer);
  if (!(IDLE_EXIT_MS > 0)) return; // 0 / 非法 = 常驻,见上面
  idleTimer = setTimeout(async () => {
    try { await bakery?.close(); } catch { /* 关不掉也要退,别把进程留在这儿 */ }
    process.exit(0);
  }, IDLE_EXIT_MS);
  // 定时器不该把进程钉住:父进程 disconnect 之后我们要能自然退出
  idleTimer.unref?.();
}

/** 丢掉当前 bakery(出错或到期)。关不掉不算失败 —— 进程退出时系统会收 */
async function dropBakery() {
  const old = bakery;
  bakery = null;
  jobsDone = 0;
  try { await old?.close(); } catch { /* ignore */ }
}

/**
 * 备好一个停在 `url` 上的 bakery。
 *
 * 三种情形:没有 → 开一个(openBakery 自己会 goto);有但停在别的地址 → reset 换一个新 page;
 * 有且就停在这个地址 → **仍然要 reset**。最后这条容易被当成可以省掉的一步,不能省:
 * 上一趟渲完页面已经被推到了片尾、动画锚点全都建好了,原地再渲一趟拿到的不是第 0 帧的画面。
 */
async function bakeryFor(url) {
  lastUrl = url;
  if (!bakery) {
    bakery = await openBakery({ url });
    return bakery;
  }
  /*
   * 有备用页就不导航:把这趟的项目直接灌进一个提前开好的全新空页(见 server/bakery/chrome.mjs 的 resetWith)。
   * 拿不到项目(地址里没有 timeline、取不回来)就退回老路 —— 新开 page 导航过去。
   */
  const project = await projectOf(url).catch(() => null);
  if (project) await bakery.resetWith(project, emptyUrlOf(url));
  else await bakery.reset(null, url);
  return bakery;
}

/** 同一个源上的空项目导出页:备用页停在这里,什么卡都不挂 */
function emptyUrlOf(url) {
  const empty = { width: 1920, height: 1080, fps: 30, duration: 1, clips: [] };
  return `${new URL(url).origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)))}`;
}

/** 导出页地址里 timeline 参数指向的项目 JSON(data: 直接解;/@export/... 之类的相对地址向同一个源取) */
async function projectOf(url) {
  const u = new URL(url);
  const tl = u.searchParams.get('timeline');
  if (!tl) return null;
  if (tl.startsWith('data:')) {
    const comma = tl.indexOf(',');
    return JSON.parse(decodeURIComponent(tl.slice(comma + 1)));
  }
  const res = await fetch(new URL(tl, u.origin));
  if (!res.ok) throw new Error(`取项目失败 HTTP ${res.status}`);
  return await res.json();
}

/**
 * 趁闲把下一趟要用的备用页开好。不等它:下一趟 resetWith 会自己等。
 * 备用页就绪、而且**手上没有别的活**时才回一声 hot —— 界面那对热备渲染器靠它挑「谁是热的」;
 * 手上还排着活的时候报 hot,父进程会把一台忙着的当成热的派活过来。
 */
function preloadNext(url) {
  try {
    const p = bakery?.preload(emptyUrlOf(url));
    // 备用页开不出来(浏览器已经不在了)、手上又没活:丢掉 bakery,下一次预热重开一个,别让它一直不热
    p?.then((s) => { if (s && jobsInHand === 0) process.send?.({ type: 'hot' }); }, () => { if (jobsInHand === 0) dropBakery(); });
  } catch { /* 地址不合法就算了,下一趟走老路 */ }
}

async function runJob(opts, signal) {
  if (jobsDone >= MAX_JOBS) await dropBakery();
  try {
    const b = await bakeryFor(opts.url);
    // 开页(尤其是冷启动)不看 signal;开完先看一眼,已经不要了就别再推帧
    if (signal.aborted) throw cancelledError();
    const baked = await bakeFrames(b, { ...opts, signal });
    jobsDone++;
    preloadNext(opts.url);
    return baked;
  } catch (e) {
    if (e?.cancelled) {
      // 见「三条自保规矩」第 1 条的例外:停在两帧之间,只换页。下一趟 resetWith 会关掉这张旧页
      preloadNext(opts.url);
      throw e;
    }
    // 见「三条自保规矩」第 1 条:这个页面已经不可信了(备用页随浏览器一起关)
    await dropBakery();
    throw e;
  }
}

/** 一次只干一活:并行由父进程那边的池子决定,一个 worker 一个 Chrome 一趟活 */
let chain = Promise.resolve();

process.on('message', (msg) => {
  if (!msg) return;
  /*
   * **预热**:现在就起 Chrome、加载好导出页,别等第一个活来了才开机。
   *
   * 给前台那个常驻 worker 用。用户拖时间轴松手的那一刻才派活,如果那时候 Chrome 还没起,
   * 他要多等约 1.3 秒 —— 而这 1.3 秒完全可以在他还在拖的时候就付掉。
   * 预热用的地址随便给一个导出页就行:真正的活来了会 reset 到它自己的项目地址上。
   */
  if (msg.type === 'prewarm') {
    /*
     * 预热失败(实测:「Browser target is not found」—— 手里的 bakery 背后那个浏览器已经不在了)就把 bakery 丢掉。
     * 以前这里把错误吞了、bakery 留着,之后每一次预热都在同一个死掉的浏览器上失败,永远报不出 hot,
     * 热备那边只能看着它一直「空闲、不热」;丢掉之后,下一次预热(热备巡检每 5 秒催一次)会开一个新的。
     */
    chain = chain.then(() => bakeryFor(msg.url).then(() => preloadNext(msg.url), () => dropBakery()));
    return;
  }
  /*
   * 取消。正在跑的那一趟:拨一下它的 signal,bakeFrames 在下一帧开头停下;
   * 还排在链上没开跑的:记下来,轮到它时直接回 cancelled;已经做完的:什么都不用做。
   * 不在这里回 error —— 回话统一由那一趟自己的收尾发,免得同一个 id 回两次。
   */
  if (msg.type === 'cancel') {
    if (current && current.id === msg.id) current.ac.abort();
    else if (jobsInHand > 0) {
      if (cancelledEarly.size >= CANCELLED_EARLY_MAX) cancelledEarly.clear();
      cancelledEarly.add(msg.id);
    }
    return;
  }
  /*
   * 卡片源码变了。备用页是提前开好的,里面加载的是**改之前**的模块 —— 拿它灌下一个项目,
   * 渲出来的就是旧卡片,而且不报错。扔掉它,下一趟现开一张(或者闲着时重新备一张)。
   */
  if (msg.type === 'invalidate') {
    chain = chain.then(() => {
      bakery?.dropSpare?.();
      if (lastUrl) preloadNext(lastUrl);
    });
    return;
  }
  if (msg.type === 'post') {
    chain = chain.then(async () => {
      try {
        const results = [];
        for (const item of msg.items || []) results.push(await postFrame(item));
        process.send?.({ type: 'done', id: msg.id, result: results });
      } catch (e) {
        process.send?.({ type: 'error', id: msg.id, message: e?.message || String(e) });
      }
      /*
       * 后处理做完再报一次 hot。渲帧那一趟收尾时报过,但那时父进程还在等这一步后处理、这台还算忙,
       * 那一声被忽略了(父进程只在空闲时认 hot);不在这里补的话,「热」就一直停在 0,
       * 热备调度退回到「挑一台空着的」,新活可能落到还在开备用页的那台上。
       */
      if (jobsInHand === 0 && bakery?.spare) bakery.spare.then((s) => { if (s && jobsInHand === 0) process.send?.({ type: 'hot' }); }, () => {});
    });
    return;
  }
  if (msg.type !== 'bake') return;
  clearTimeout(idleTimer);
  jobsInHand++;
  chain = chain.then(async () => {
    /*
     * 先回一声「接住了」。父进程靠它区分两种失败:活儿开跑之后崩的(不能重发,可能已经写了文件),
     * 和**根本没开跑**的 —— 后者只有一种成因:派活的那一刻这个 worker 正好闲置超时自己退了。
     * 那种情况父进程换一个新 worker 重来一次,用户看不见任何异常(见 runExport 的重试)。
     */
    process.send?.({ type: 'started', id: msg.id });
    try {
      if (cancelledEarly.delete(msg.id)) {
        process.send?.({ type: 'error', id: msg.id, message: '已取消', cancelled: true });
        return;
      }
      const ac = new AbortController();
      current = { id: msg.id, ac };
      try {
        const result = await runJob(msg.opts || {}, ac.signal);
        process.send?.({ type: 'done', id: msg.id, result });
      } catch (e) {
        process.send?.({ type: 'error', id: msg.id, message: e?.message || String(e), cancelled: !!e?.cancelled });
      } finally {
        current = null;
      }
    } finally {
      jobsInHand--;
      armIdleExit();
      // 手上的活都清了、备用页也在:告诉父进程这台又热了(没有备用页的话 preloadNext 那边会在它开好时报)
      if (jobsInHand === 0 && bakery?.spare) bakery.spare.then((s) => { if (s && jobsInHand === 0) process.send?.({ type: 'hot' }); }, () => {});
    }
  });
});

// 父进程没了就别留着一个 Chrome 在后台烧内存
process.on('disconnect', async () => {
  try { await bakery?.close(); } catch { /* ignore */ }
  process.exit(0);
});

armIdleExit();
process.send?.({ type: 'ready' });
