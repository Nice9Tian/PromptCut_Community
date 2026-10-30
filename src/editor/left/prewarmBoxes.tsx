import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { allCards } from "../../kernel/registry";
import { allParts } from "../../kernel/partRegistry";
import { assetCardKind } from "../../cards/assets";
import { AnimClock } from "../../kernel/AnimClock";
import { PartTree } from "../../render/PartTree";
import { themeStyle } from "../../themes";
import { getState } from "../../store/project";
import type { CardDef, PartInstance } from "../../kernel/types";
import type { PartDef } from "../../kernel/partTypes";
import { measureAcrossTime, unionBox, type Box } from "../../render/contentBox";
import { knownKeys, rememberBox, dumpBoxes } from "./previewBoxes";

/**
 * 后台补量:第一次打开卡片页时,把静态表里没有的卡片 / 部件挨个在屏幕外渲染一遍、
 * 量出包围盒存起来(previewBoxes.ts)。算完的下次悬停一步到位,不用再等测量跑。
 *
 * 几条自我约束:
 *   - **一次只渲一个**,而且排在空闲时段(requestIdleCallback),不跟用户的操作抢主线程;
 *   - **用户刚动过就先让开**:点击、按键、滚轮之后 QUIET_MS 内不挂新卡、不做第二次量;
 *     挂上去之后、第一次量之前用户动了,这张卡卸掉放回队尾。三维卡挂上去就是上百毫秒(建 WebGL 场景、
 *     编译着色器),量一次要从显卡读回整张画布,正好撞上用户点开一个组、收起一个面板,那一下动画就卡住了 ——
 *     以前打开「自家卡片」之后半分钟里点什么都一顿一顿的,就是它;
 *   - **屏幕外而不是 display:none**:隐藏起来的元素没有布局也没有动画,什么都量不到;
 *   - **粒子卡不排队**:53 张全是 canvas 引擎,后台一张张点火代价太大,而且它们本来就
 *     铺满整幅、量出来是 null。它们靠悬停时的像素扫描(contentBox 的 canvasBox)就够。
 */
const SETTLE_MS = 80;
const MAX_MEASURE_MS = 4000;
const GAP_MS = 120;
/** 跟真实时间走的部件(打字机、Lottie)等它长出来的上限 */
const SETTLED_WAIT_MS = 1800;
/** 用户最后一次点击 / 按键 / 滚轮之后,至少安静这么久才开始下一步 */
const QUIET_MS = 1500;
/** 一张卡最多给用户让这么多回(挂上去就被打断、放回队尾),再往后照量不误,免得排不到头 */
const MAX_YIELDS = 3;

interface Job {
  key: string;
  /** t:部件按秒计的时间轴位置(卡片用不到) */
  node: (t: number) => React.ReactElement;
  animMs: number;
  /** 已经给用户让过几回 */
  yields?: number;
}

let started = false;
let pending = 0;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let lastInput = 0;
let watching = false;

function idle(fn: () => void, timeout = 2000) {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout });
  else window.setTimeout(fn, GAP_MS);
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * 记下用户最后一次操作的时刻。捕获阶段 + passive,不影响任何人的事件处理。
 * click 单独算一种:键盘回车 / 空格按下按钮、脚本里的 el.click() 都没有 pointerdown。
 */
function watchInput() {
  if (watching) return;
  watching = true;
  const mark = () => {
    lastInput = performance.now();
  };
  for (const type of ["pointerdown", "click", "keydown", "wheel"]) {
    window.addEventListener(type, mark, { capture: true, passive: true });
  }
}

/** 等到「用户安静了 QUIET_MS」且浏览器给了一次空闲回调;空闲回调排队期间用户又动了,就再等一轮 */
function whenQuiet(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const left = QUIET_MS - (performance.now() - lastInput);
      if (left > 0) {
        window.setTimeout(check, left);
        return;
      }
      idle(() => {
        if (performance.now() - lastInput < QUIET_MS) check();
        else resolve();
      });
    };
    check();
  });
}

function cardAnimMs(def: CardDef<any>): number {
  try {
    const dyn = def.timing?.(def.defaults)?.settleMs;
    if (typeof dyn === "number" && Number.isFinite(dyn)) return dyn;
  } catch { /* 算炸了按静态值 */ }
  const st = def.lifecycle?.settleMs;
  return typeof st === "number" && Number.isFinite(st) ? st : 1500;
}

function partAnimMs(def: PartDef<any>): number {
  try {
    const v = def.settleMs?.(def.defaults);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  } catch { /* 同上 */ }
  return 1500;
}

function ensureStage(w: number, h: number, themeId: string): HTMLElement {
  if (!container) {
    container = document.createElement("div");
    container.setAttribute("data-pc", "prewarm");
    container.setAttribute("aria-hidden", "true");
    document.body.appendChild(container);
  }
  container.style.cssText = `position:fixed;left:-20000px;top:0;width:${w}px;height:${h}px;overflow:hidden;pointer-events:none;z-index:-1;`;
  // 主题是一串 CSS 自定义属性,只能一条条 setProperty
  for (const [k, v] of Object.entries(themeStyle(themeId) as Record<string, string>)) {
    if (k.startsWith("--")) container.style.setProperty(k, String(v));
  }
  if (!root) root = createRoot(container);
  return container;
}

/** @returns false = 挂上去之后用户马上动了,这张没量,要放回队尾 */
async function runJob(job: Job, w: number, h: number, themeId: string): Promise<boolean> {
  // 挂卡是一步里最重的,挂之前先等用户安静下来;flushSync 当场挂完 ——
  // 交给 React 自己排的话,真正挂载会落到之后的某个任务里,那时用户可能已经在点了
  await whenQuiet();
  const host = ensureStage(w, h, themeId);
  const total = Math.min(MAX_MEASURE_MS, Math.max(400, job.animMs) + 300);
  const inputAtMount = lastInput;
  flushSync(() => {
    root!.render(
      <div className="pc-stage" style={{ position: "relative", width: "100%", height: "100%" }}>
        <AnimClock speed={1}>{job.node(total / 1000)}</AnimClock>
      </div>,
    );
  });
  let box: Box | null = null;
  const sample = () => {
    const stage = host.querySelector<HTMLElement>(".pc-stage");
    if (!stage) return;
    try {
      box = unionBox(box, measureAcrossTime(stage, total));
    } catch {
      // 哪张卡渲染炸了都不该拖垮整条队列
    }
  };
  // 量两回:刚挂上去(入场从画外飞进来的那一段靠拨 Web Animations 取到),
  // 再等它跑一会儿(打字机、Lottie 这些跟真实时间走的,拨不动,只能等内容自己长出来)。
  await wait(SETTLE_MS);
  // 第一回不能往后拖:入场动画跑完就拨不到了。挂上去这一小段里用户动了的话,
  // 读画布正好撞上他的动画 —— 这回不量,卸掉整张放回队尾重来
  if (lastInput !== inputAtMount && (job.yields ?? 0) < MAX_YIELDS) {
    root!.render(null);
    job.yields = (job.yields ?? 0) + 1;
    return false;
  }
  sample();
  // 第二回量的是长好的样子。卡挂着就一直在渲染(AnimClock 的 rAF、三维卡的 WebGL),
  // 所以不能挂着干等用户停手:到点了用户还在动,就跟第一回一样卸掉放回队尾;让够了照量不误
  await wait(Math.min(total, SETTLED_WAIT_MS));
  if (performance.now() - lastInput < QUIET_MS && (job.yields ?? 0) < MAX_YIELDS) {
    root!.render(null);
    job.yields = (job.yields ?? 0) + 1;
    return false;
  }
  sample();
  rememberBox(job.key, w, h, box);
  root!.render(null);
  await wait(30);
  return true;
}

function buildQueue(w: number, h: number, force: boolean): Job[] {
  // force(生成静态表)= 不认静态表,但认本机缓存,重载后能接着量
  const known = knownKeys(w, h, force);
  const jobs: Job[] = [];
  for (const def of allCards()) {
    // 粒子卡不排队:见上面的说明
    if (assetCardKind(def) === "particles") continue;
    // 素材效果卡没有 React 组件,离屏量不出包围盒 —— 库里也只显示静态占位,不用预热
    const Component = def.Component;
    if (typeof Component !== "function") continue;
    const key = `card:${def.id}`;
    if (known.has(key)) continue;
    jobs.push({ key, animMs: cardAnimMs(def), node: () => <Component params={def.defaults} playToken={1} /> });
  }
  for (const def of allParts()) {
    const key = `part:${def.id}`;
    if (known.has(key)) continue;
    const parts: PartInstance[] = [
      { id: "preview", partId: def.id, params: { ...def.defaults }, ...(def.defaultFrame ? { frame: { ...def.defaultFrame } } : {}) },
    ];
    jobs.push({ key, animMs: partAnimMs(def), node: (t: number) => <PartTree parts={parts} size={{ width: w, height: h }} t={t} playToken={1} /> });
  }
  return jobs;
}

/**
 * 开始后台补量。重复调用无副作用;无头实例(agent 那份页面)不做这件事。
 * `force` 只给 scripts/preview-boxes.mjs 用:重新量一遍静态表里的东西。
 */
export function startPrewarm(force = false): void {
  if ((started && !force) || typeof document === "undefined") return;
  try {
    if (new URLSearchParams(location.search).has("headless")) return;
  } catch { /* 拿不到就当普通页面 */ }
  started = true;
  watchInput();
  // 补量是「用户点开了一个卡片组」那一下带起来的,那次点击发生在监听装上之前:启动时刻就当作一次操作,别紧跟着挂卡
  lastInput = performance.now();
  const { width, height, themeId } = getState().project;
  const queue = buildQueue(width, height, force);
  pending = queue.length;
  const next = () => {
    const job = queue.shift();
    if (!job) {
      pending = 0;
      root?.render(null);
      return;
    }
    // 空闲 + 用户安静的等待在 runJob 里(whenQuiet)
    void runJob(job, width, height, themeId)
      .then((done) => {
        if (!done) queue.push(job);
      })
      .finally(() => {
        pending = queue.length;
        next();
      });
  };
  next();
}

/** 给 scripts/preview-boxes.mjs 用:催一遍、看还剩几个、把结果拿走 */
if (typeof window !== "undefined") {
  (window as unknown as { __pcPreviewBoxes?: unknown }).__pcPreviewBoxes = {
    start: (force?: boolean) => startPrewarm(force === true),
    get pending() {
      return pending;
    },
    get started() {
      return started;
    },
    dump: () => {
      const { width, height } = getState().project;
      return dumpBoxes(width, height);
    },
  };
}
