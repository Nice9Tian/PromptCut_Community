import type { Box } from "../../render/contentBox";
import staticFile from "../../cards/preview-boxes.json";

/**
 * 预览卡包围盒的三层存放:静态表 → 本机缓存 → 这次会话量到的。
 *
 * 为什么要存:量一次要把动效从头到尾拨一遍(几十档),第一次悬停会有一小下黑屏。
 * 卡片的默认参数是固定的,盒子也就是固定的 —— 那就没必要每台机器、每次开软件都重量:
 *
 *   1. **静态表**(`src/cards/preview-boxes.json`,`npm run preview-boxes` 离线生成并入库):
 *      随包发出去,开箱即用,一步到位;
 *   2. **本机缓存**(localStorage):静态表里没有的(用户 / AI 现场建的卡、新加的部件),
 *      后台补量一次就记住,下次开软件还在;
 *   3. **内存**:这次会话量到的,顺手写进本机缓存。
 *
 * 盒子是舞台坐标(项目像素),所以按舞台尺寸分桶存:1920×1080 量的盒子不能给竖屏项目用。
 */
export type BoxTuple = [number, number, number, number];

/**
 * 静态表的类型按 **JSON 导入进来的样子**写,而不是按我们希望的样子写:
 * TS 把 json 里的数组推成 `number[]`,不是定长元组,断言成元组会被拒(TS2352)。
 * 定长是生成脚本(scripts/preview-boxes.mjs)那头保证的,这边只读不写,拿 `number[]` 就够用。
 */
interface StaticFile {
  /** 这张表是哪一版量的。重新生成就变,本机缓存跟着作废(那是旧代码量出来的) */
  rev?: number;
  stage: number[];
  boxes: Record<string, number[] | null>;
}

const LS_KEY = "pc.previewBoxes.v1";
const statics: StaticFile = staticFile;

/** 舞台分桶的键 */
function bucket(w: number, h: number): string {
  return `${Math.round(w)}x${Math.round(h)}`;
}

function toBox(t: readonly number[] | null | undefined): Box | null {
  return t ? { l: t[0], t: t[1], r: t[2], b: t[3] } : null;
}

function toTuple(b: Box | null): BoxTuple | null {
  return b ? [Math.round(b.l), Math.round(b.t), Math.round(b.r), Math.round(b.b)] : null;
}

/** 本机缓存:{ "1920x1080": { "card:xxx": [l,t,r,b] | null } } */
type Store = Record<string, Record<string, BoxTuple | null>>;

let mem: Store | null = null;

function load(): Store {
  if (mem) return mem;
  mem = {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    // 只认同一版静态表下量的:表重新生成过(卡片改了动画 / 默认参数),本机这份就是旧结论,整份丢掉
    if (parsed && typeof parsed === "object" && parsed.rev === (statics.rev ?? 0) && parsed.buckets) {
      mem = parsed.buckets as Store;
    }
  } catch {
    // 存坏了、被禁用了都不要紧,大不了重量一遍
  }
  return mem;
}

let saveTimer: number | null = null;
function saveSoon() {
  if (saveTimer !== null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ rev: statics.rev ?? 0, buckets: mem ?? {} }));
    } catch {
      // 满了 / 隐私模式:算了,这是缓存不是数据
    }
  }, 800);
}

/**
 * 查一个盒子。`has` 为 false 表示从来没量过(要去量);为 true 而 `box` 为 null
 * 表示**量过了,结论就是「内容铺满整幅」**,按整幅显示即可,别再白量一遍。
 */
export function lookupBox(key: string, stageW: number, stageH: number): { has: boolean; box: Box | null } {
  const b = bucket(stageW, stageH);
  const local = load()[b];
  if (local && key in local) return { has: true, box: toBox(local[key]) };
  // 静态表只在舞台尺寸对得上时才作数
  if (b === bucket(statics.stage?.[0] ?? 0, statics.stage?.[1] ?? 0) && key in (statics.boxes ?? {})) {
    return { has: true, box: toBox(statics.boxes[key]) };
  }
  return { has: false, box: null };
}

export function rememberBox(key: string, stageW: number, stageH: number, box: Box | null): void {
  const b = bucket(stageW, stageH);
  const store = load();
  (store[b] ??= {})[key] = toTuple(box);
  saveSoon();
}

/**
 * 有静态表 / 本机缓存的键(给后台补量用:已经有的不用再排队)。
 * `ignoreStatic` 是给生成静态表的脚本用的:那时候静态表正是要重算的东西,不能当成「已经有了」,
 * 但本机缓存要认 —— 页面中途被顶得重载时,接着量就行,不用从头来。
 */
export function knownKeys(stageW: number, stageH: number, ignoreStatic = false): Set<string> {
  const b = bucket(stageW, stageH);
  const out = new Set<string>(Object.keys(load()[b] ?? {}));
  if (!ignoreStatic && b === bucket(statics.stage?.[0] ?? 0, statics.stage?.[1] ?? 0)) {
    for (const k of Object.keys(statics.boxes ?? {})) out.add(k);
  }
  return out;
}

/** 卡片源码改了、参数默认值变了,量出来的盒子就过时了 —— 让人能手动丢掉 */
export function forgetBoxes(stageW?: number, stageH?: number): void {
  if (stageW && stageH) {
    const store = load();
    delete store[bucket(stageW, stageH)];
  } else {
    mem = {};
  }
  saveSoon();
}

/** 导出这次量到的一切,给 scripts/preview-boxes.mjs 生成静态表 */
export function dumpBoxes(stageW: number, stageH: number): StaticFile {
  return { stage: [Math.round(stageW), Math.round(stageH)], boxes: { ...(load()[bucket(stageW, stageH)] ?? {}) } };
}
