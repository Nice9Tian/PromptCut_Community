import type { ClipFrame, Control, PartInstance } from "./types";
import type { PartDef } from "./partTypes";
import { frameBox, resolveFrame, type Box, type Size } from "./layout.ts";

/**
 * 组合卡的部件实例树:纯函数,不碰 store。
 *
 *   - 增删改移都返回**新树**(原树不动),store 拿到直接存;
 *   - 校验和写入分开:先 validatePartTree 把整棵树看一遍,一处不合法整棵不写;
 *   - 世界坐标由父框逐级合成(partWorldBox),**只存局部框**,和卡片级 frame 一个原则;
 *   - 时序(partsTiming)按每个实例的 enterMs + 部件自己的 settleMs 算,给封装和代码页显示。
 *
 * 部件的注册表由调用方传进来(lookup),这样 node 里能单测,不用拉起 React。
 */

export type PartLookup = (id: string) => PartDef<any> | undefined;

export function newPartInstanceId(): string {
  return "p" + Math.random().toString(36).slice(2, 8);
}

/** 树里找一个实例,顺带给出它的父数组和下标(增删移都要) */
export function findPart(tree: PartInstance[], id: string): { node: PartInstance; parent: PartInstance[]; index: number; parentId: string | null } | null {
  const walk = (list: PartInstance[], parentId: string | null): ReturnType<typeof findPart> => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.id === id) return { node: n, parent: list, index: i, parentId };
      if (n.children?.length) {
        const hit = walk(n.children, n.id);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(tree, null);
}

export function flattenParts(tree: PartInstance[]): PartInstance[] {
  const out: PartInstance[] = [];
  const walk = (list: PartInstance[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/* ---------------- 校验 ---------------- */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/**
 * 部件的 frame 允许哪些键。
 *
 * **故意不含 rotateX / rotateY / translateZ** —— 部件级三维现在渲染接不住,放行等于给一个
 * 假的能力。CSS 的 `perspective` 只作用于直接子元素,链路是
 * `AnimClock(perspective) → 卡片 div → 部件 div`,要传到部件那一层得靠卡片 div 的 preserve-3d,
 * 而那个只在**卡片自己的 frame** 是三维时才写。实测部件 rotateY(40°) 的外接框高度:
 *   卡片 div 无 preserve-3d(卡片是二维时的常态) 300.00 —— 纯仿射斜切,没有近大远小
 *   卡片 div 有 preserve-3d                      336.44 —— 才是真透视
 * 而且就算卡片也摆进了空间,只要这张卡带了淡入淡出 / 强调,Stage 会把 opacity / filter
 * 写在同一个 div 上,透视又归零(实测同样回到 300.00)。
 *
 * 三种情况给三个结果,和素材层被 reject3dOnMedia 拒掉是同一个理由:
 * 宁可当场说不行,也别让 Agent 设了以为成了。要三维就整张卡摆(set_position 的三维参数)。
 * kernel/envelope.ts 里 clip 级那份清单是**含**三维的,那一层渲染是对的。
 */
const FRAME_KEYS = new Set(["x", "y", "w", "h", "anchor", "scale", "rotate"]);
const PART_3D_KEYS = ["rotateX", "rotateY", "translateZ"];

/** 一棵树最多多少个实例。MCP 传进来的是任意 JSON,没上限的话一次就能塞进几万个节点 */
export const MAX_PART_NODES = 200;

export function validatePartFrame(raw: unknown, where: string): ClipFrame | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!isObj(raw)) throw new Error(`${where} 的 frame 要是对象或 null(null = 铺满父框)`);
  for (const k of Object.keys(raw)) {
    if (FRAME_KEYS.has(k)) continue;
    if (PART_3D_KEYS.includes(k)) {
      throw new Error(
        `${where} 的 frame 暂时不支持 ${k}:三维只能整张卡摆(set_position 的 rotateX / rotateY / translateZ),` +
        `部件那一层拿不到透视,设了只会得到仿射斜切,而且这张卡一带淡入淡出或强调连斜切都会变样。` +
        `要让这个部件立体,把它单独做成一张卡再摆。`,
      );
    }
    throw new Error(`${where} 的 frame 不认识 "${k}",只有 x / y / w / h / anchor / scale / rotate`);
  }
  if (!isNum(raw.x) || !isNum(raw.y)) throw new Error(`${where} 的 frame.x / frame.y 必须是数字(锚点在父框里的位置)`);
  for (const k of ["w", "h", "scale", "rotate"] as const) if (raw[k] !== undefined && !isNum(raw[k])) throw new Error(`${where} 的 frame.${k} 要是数字`);
  for (const k of ["w", "h", "scale"] as const) if (raw[k] !== undefined && (raw[k] as number) <= 0) throw new Error(`${where} 的 frame.${k} 要大于 0`);
  if (raw.anchor !== undefined) {
    const a = raw.anchor;
    if (!Array.isArray(a) || a.length !== 2 || !isNum(a[0]) || !isNum(a[1])) throw new Error(`${where} 的 frame.anchor 要是 [ax, ay] 两个数字,0~1`);
  }
  // 重建对象:键序固定、不带多余字段,原样写回的比较才不会因为键序不同判成改了
  const f = raw as Record<string, unknown>;
  return {
    x: f.x as number,
    y: f.y as number,
    ...(f.w !== undefined ? { w: f.w as number } : {}),
    ...(f.h !== undefined ? { h: f.h as number } : {}),
    ...(f.anchor !== undefined ? { anchor: [(f.anchor as number[])[0], (f.anchor as number[])[1]] as [number, number] } : {}),
    ...(f.scale !== undefined ? { scale: f.scale as number } : {}),
    ...(f.rotate !== undefined ? { rotate: f.rotate as number } : {}),
    // 这里是**显式重建**:上面放行了什么,这里就要有什么,否则会出现「校验通过、值被悄悄丢掉」。
    // 三维那三项上面直接拒了,所以这里也不该有 —— 两处一起看才说得清。
  };
}

function describeControl(c: Control): string {
  const bits = [`${c.key}(${c.label},${c.type}`];
  if (c.type === "select") bits.push(`取值 ${c.options.map((o) => o.value).join("/")}`);
  if (c.required) bits.push("必填");
  return bits.join(",") + ")";
}

/** 部件参数:键名要真有、select 在选项里、number 是数字、必填不能空。返回和 defaults 合并后的全量 */
export function validatePartParams(def: PartDef<any>, patch: Record<string, unknown> | undefined, existing?: Record<string, unknown>): Record<string, unknown> {
  const known = new Map(def.controls.map((c) => [c.key, c]));
  const problems: string[] = [];
  for (const [key, value] of Object.entries(patch || {})) {
    const control = known.get(key);
    if (!control) {
      problems.push(`参数 "${key}" 不是部件 ${def.id} 的参数。它接受:${def.controls.map(describeControl).join("、")}`);
      continue;
    }
    if (control.type === "number" && typeof value !== "number") problems.push(`参数 "${key}" 要数字,收到 ${JSON.stringify(value)}`);
    if (control.type === "select" && !control.options.some((o) => o.value === value)) problems.push(`参数 "${key}" 只能是 ${control.options.map((o) => o.value).join(" / ")},收到 ${JSON.stringify(value)}`);
  }
  const merged = { ...def.defaults, ...(existing || {}), ...(patch || {}) };
  for (const c of def.controls) {
    const v = merged[c.key];
    const filled = v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
    if (c.required && !filled) problems.push(`部件 ${def.id} 的 "${c.key}"(${c.label})是必填的,不能为空。${c.hint ?? ""}`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return merged;
}

/** 整棵树:实例 id 唯一、partId 存在、参数合法、frame 合法、enterMs 非负、嵌套不超过 4 层 */
export function validatePartTree(tree: unknown, lookup: PartLookup): PartInstance[] {
  if (!Array.isArray(tree)) throw new Error("parts 要是数组");
  const ids = new Set<string>();
  let count = 0;
  const walk = (list: unknown[], depth: number, path: string): PartInstance[] =>
    list.map((raw, i) => {
      const where = `${path}[${i}]`;
      if (!isObj(raw)) throw new Error(`${where} 要是对象 { id, partId, params, frame?, enterMs?, children? }`);
      if (++count > MAX_PART_NODES) throw new Error(`部件树最多 ${MAX_PART_NODES} 个实例`);
      const id = raw.id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error(`${where}.id 要是短字符串(字母数字 - _)`);
      if (ids.has(id)) throw new Error(`部件实例 id "${id}" 重复`);
      ids.add(id);
      if (typeof raw.partId !== "string") throw new Error(`${where}.partId 要是部件 id(list_parts 里的)`);
      const def = lookup(raw.partId);
      if (!def) throw new Error(`没有 id 为 "${raw.partId}" 的部件,list_parts 看有哪些`);
      if (raw.params !== undefined && !isObj(raw.params)) throw new Error(`${where}.params 要是对象`);
      const params = validatePartParams(def, raw.params as Record<string, unknown> | undefined);
      const frame = validatePartFrame(raw.frame, where);
      if (raw.enterMs !== undefined && (!isNum(raw.enterMs) || (raw.enterMs as number) < 0)) throw new Error(`${where}.enterMs 要是非负毫秒数`);
      if (raw.label !== undefined && typeof raw.label !== "string") throw new Error(`${where}.label 要是字符串`);
      if (depth >= 4 && Array.isArray(raw.children) && raw.children.length) throw new Error("部件树最多嵌套 4 层");
      if (raw.children !== undefined && !Array.isArray(raw.children)) throw new Error(`${where}.children 要是数组`);
      const children = Array.isArray(raw.children) && raw.children.length ? walk(raw.children, depth + 1, `${where}.children`) : undefined;
      return {
        id,
        partId: raw.partId,
        params,
        ...(frame ? { frame } : {}),
        ...(isNum(raw.enterMs) && raw.enterMs > 0 ? { enterMs: raw.enterMs } : {}),
        ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}),
        ...(children ? { children } : {}),
      };
    });
  return walk(tree, 0, "parts");
}

/* ---------------- 增删改移(返回新树) ---------------- */

function cloneTree(tree: PartInstance[]): PartInstance[] {
  return JSON.parse(JSON.stringify(tree));
}

export interface NewPartSpec {
  partId: string;
  params?: Record<string, unknown>;
  frame?: ClipFrame | null;
  enterMs?: number;
  label?: string;
  id?: string;
}

/** 加一个实例。parentId 省略 = 加在根;index 省略 = 追加到末尾。frame 省略 = 部件的 defaultFrame */
export function addPart(tree: PartInstance[], spec: NewPartSpec, lookup: PartLookup, at?: { parentId?: string | null; index?: number }): { tree: PartInstance[]; node: PartInstance } {
  const def = lookup(spec.partId);
  if (!def) throw new Error(`没有 id 为 "${spec.partId}" 的部件,list_parts 看有哪些`);
  const id = spec.id ?? newPartInstanceId();
  if (findPart(tree, id)) throw new Error(`部件实例 id "${id}" 已经存在`);
  if (flattenParts(tree).length >= MAX_PART_NODES) throw new Error(`部件树最多 ${MAX_PART_NODES} 个实例`);
  const params = validatePartParams(def, spec.params);
  const frame = spec.frame === undefined ? (def.defaultFrame ? { ...def.defaultFrame } : undefined) : validatePartFrame(spec.frame, `部件 ${id}`);
  if (spec.enterMs !== undefined && (!isNum(spec.enterMs) || spec.enterMs < 0)) throw new Error("enterMs 要是非负毫秒数");
  const node: PartInstance = {
    id,
    partId: spec.partId,
    params,
    ...(frame ? { frame } : {}),
    ...(spec.enterMs ? { enterMs: spec.enterMs } : {}),
    ...(spec.label ? { label: spec.label } : {}),
  };
  const next = cloneTree(tree);
  let list = next;
  if (at?.parentId) {
    const hit = findPart(next, at.parentId);
    if (!hit) throw new Error(`找不到父部件 ${at.parentId}`);
    hit.node.children ??= [];
    list = hit.node.children;
  }
  const index = at?.index === undefined ? list.length : Math.max(0, Math.min(list.length, at.index | 0));
  list.splice(index, 0, node);
  return { tree: next, node };
}

export function removePart(tree: PartInstance[], id: string): PartInstance[] {
  const next = cloneTree(tree);
  const hit = findPart(next, id);
  if (!hit) throw new Error(`找不到部件实例 ${id}`);
  hit.parent.splice(hit.index, 1);
  return next;
}

export interface PartPatch {
  params?: Record<string, unknown>;
  /** null = 清掉框(铺满父框) */
  frame?: ClipFrame | null;
  enterMs?: number;
  label?: string;
}

/** 改参数 / 框 / 时序。参数是稀疏合并;frame 传了就整个替换(传 null 清掉) */
export function updatePart(tree: PartInstance[], id: string, patch: PartPatch, lookup: PartLookup): { tree: PartInstance[]; node: PartInstance } {
  const next = cloneTree(tree);
  const hit = findPart(next, id);
  if (!hit) throw new Error(`找不到部件实例 ${id}`);
  const def = lookup(hit.node.partId);
  if (!def) throw new Error(`部件 ${hit.node.partId} 已经不存在了`);
  if (patch.params !== undefined) {
    if (!isObj(patch.params)) throw new Error("params 要是对象");
    hit.node.params = validatePartParams(def, patch.params, hit.node.params);
  }
  if (patch.frame !== undefined) {
    const f = validatePartFrame(patch.frame, `部件 ${id}`);
    if (f) hit.node.frame = f;
    else delete hit.node.frame;
  }
  if (patch.enterMs !== undefined) {
    if (!isNum(patch.enterMs) || patch.enterMs < 0) throw new Error("enterMs 要是非负毫秒数");
    if (patch.enterMs > 0) hit.node.enterMs = patch.enterMs;
    else delete hit.node.enterMs;
  }
  if (patch.label !== undefined) {
    if (patch.label) hit.node.label = String(patch.label);
    else delete hit.node.label;
  }
  return { tree: next, node: hit.node };
}

/** 挪到别的父节点 / 别的位置。parentId null = 根;不能挪进自己的子树 */
export function movePart(tree: PartInstance[], id: string, to: { parentId?: string | null; index?: number }): PartInstance[] {
  const next = cloneTree(tree);
  const hit = findPart(next, id);
  if (!hit) throw new Error(`找不到部件实例 ${id}`);
  if (to.parentId && (to.parentId === id || findPart(hit.node.children ?? [], to.parentId))) throw new Error("不能把部件挪进它自己的子树");
  const [node] = hit.parent.splice(hit.index, 1);
  let list = next;
  if (to.parentId) {
    const p = findPart(next, to.parentId);
    if (!p) throw new Error(`找不到父部件 ${to.parentId}`);
    p.node.children ??= [];
    list = p.node.children;
  }
  const index = to.index === undefined ? list.length : Math.max(0, Math.min(list.length, to.index | 0));
  list.splice(index, 0, node);
  return next;
}

/* ---------------- 坐标与时序 ---------------- */

export interface PartPlacement {
  /** 实例的框在父坐标系里的矩形(缩放前) */
  local: Box;
  /** 画面绝对矩形(父级的框和缩放逐级合成;旋转不参与,文档里说明) */
  world: Box;
  /** 累计缩放 */
  scale: number;
}

/**
 * 逐级合成每个实例的画面位置。parent 是组合卡画布在画面上的矩形(clip 的 world box)和它的累计缩放。
 * 每个实例的框相对它的父框(根实例的父框就是画布),子实例的父框是父实例的框。
 */
export function placeParts(tree: PartInstance[], canvas: { box: Box; scale: number }): Map<string, PartPlacement> {
  const out = new Map<string, PartPlacement>();
  const walk = (list: PartInstance[], parentBox: Box, parentScale: number) => {
    for (const n of list) {
      const size: Size = { width: parentBox.width / parentScale, height: parentBox.height / parentScale };
      const local = frameBox(n.frame, size);
      const f = resolveFrame(n.frame, size);
      const scale = parentScale * f.scale;
      const world: Box = {
        left: parentBox.left + local.left * parentScale,
        top: parentBox.top + local.top * parentScale,
        width: local.width * scale,
        height: local.height * scale,
      };
      // 缩放绕锚点:把因缩放多出 / 少掉的部分按锚点分摊
      if (f.scale !== 1) {
        const dw = local.width * parentScale * (f.scale - 1);
        const dh = local.height * parentScale * (f.scale - 1);
        world.left -= dw * f.anchor[0];
        world.top -= dh * f.anchor[1];
      }
      out.set(n.id, { local, world, scale });
      if (n.children?.length) walk(n.children, world, scale);
    }
  };
  walk(tree, canvas.box, canvas.scale);
  return out;
}

export interface PartTimingEntry {
  enterMs: number;
  settleMs: number;
  after: "hold" | "loop" | "evolve";
}

/** 每个实例的进场 / 落定(相对 clip 起点),以及整棵树的落定和「之后」 */
export function partsTiming(tree: PartInstance[], lookup: PartLookup): { settleMs: number; after: "hold" | "loop" | "evolve"; parts: Map<string, PartTimingEntry> } {
  const parts = new Map<string, PartTimingEntry>();
  let settleMs = 0;
  let after: "hold" | "loop" | "evolve" = "hold";
  const walk = (list: PartInstance[], base: number) => {
    for (const n of list) {
      const def = lookup(n.partId);
      const enter = base + (n.enterMs ?? 0);
      let own = 0;
      try { own = def?.settleMs ? def.settleMs({ ...def.defaults, ...n.params }) : 0; } catch { own = 0; }
      const settle = enter + (Number.isFinite(own) ? own : 0);
      const a = def?.after ?? "hold";
      parts.set(n.id, { enterMs: enter, settleMs: settle, after: a });
      settleMs = Math.max(settleMs, settle);
      if (a === "evolve" || (a === "loop" && after !== "evolve")) after = a;
      if (n.children?.length) walk(n.children, enter);
    }
  };
  walk(tree, 0);
  return { settleMs, after, parts };
}
