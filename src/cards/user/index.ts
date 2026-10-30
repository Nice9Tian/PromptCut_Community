import type { CardDef } from "../../kernel/types";
import { overlayModules, overlayRaws, overlayDependencyRaws } from "../userOverlay";

/**
 * 用户 / AI 后建的卡片。一个文件一张卡,放在本目录下即可,**不用改这个文件**。
 *
 * 之所以用 glob 自动收集而不是像 native 那样手写 import 清单:AI 建卡时
 * 只能写它自己那一个文件(create_card 就只允许写这里),让它顺带去改一份
 * 共享的注册表既容易改坏,也和「一次只碰一个文件」的沙箱前提冲突。
 * 这里一扫,新文件存盘 → vite HMR → list_cards 立刻就能看到它。
 */
const globModules = import.meta.glob<Record<string, unknown>>("./*.tsx", { eager: true });

/**
 * 装机版(有卡片改动层)里本机原来没有的用户卡只在改动层里,glob 看不见;卡片插件经 `../userOverlay` 另列(见那个文件)。
 * 合并时同一个键以 glob 为准(底版也有时加载钩子交出的本来就是改动层那一份),键按字典序,和只有 glob 时一样稳定。
 */
function withOverlay<T>(fromGlob: Record<string, T>, fromOverlay: Record<string, T>): Record<string, T> {
  if (Object.keys(fromOverlay).length === 0) return fromGlob;
  const merged: Record<string, T> = { ...fromOverlay, ...fromGlob };
  return Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
}
const modules = withOverlay(globModules, overlayModules);

/** 结构化判断:凡是长得像 CardDef 的具名导出都收进来 */
function isCardDef(value: unknown): value is CardDef<any> {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<CardDef<any>>;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    typeof c.defaults === "object" &&
    Array.isArray(c.controls) &&
    // 素材效果卡(card / audio)不写 Component,由宿主组件代渲;三者有其一就算一张卡
    (typeof c.Component === "function" || typeof c.card === "function" || typeof c.audio === "function")
  );
}

/**
 * 同一批文件的源码原文。存 .proc 时要把项目用到的定制卡源码一起打包进去(见 editor/io/procCards.ts),
 * 而存盘是同步的,等不了一次请求;这里跟着 HMR 一起更新,拿到的永远是磁盘上的当前版本。
 */
const raws = withOverlay(import.meta.glob<string>("./*.tsx", { eager: true, query: "?raw", import: "default" }), overlayRaws);
const dependencyRaws = withOverlay(import.meta.glob<string>("./**/*.{ts,tsx,mjs,css}", { eager: true, query: "?raw", import: "default" }), overlayDependencyRaws);

const baseOf = (path: string) => path.replace(/^\.\//, "").replace(/\.tsx$/, "");

/** 文件名(不含 .tsx)→ 源码原文 */
export const userCardFiles: Record<string, string> = Object.fromEntries(
  Object.entries(raws).map(([path, src]) => [baseOf(path), src]),
);

/** Raw dependency map for cache identity only.  Proc serialization still uses
 * userCardFiles, which deliberately contains authored card entry files only. */
export const userCardDependencies: Record<string, string> = Object.fromEntries(
  Object.entries(dependencyRaws).map(([file, source]) => [`/src/cards/user/${file.replace(/^\.\//, '')}`, source]),
);

/** 卡片 id → 定义它的文件名。通常同名,手放进来的文件不一定 */
export const userCardFileOf: Record<string, string> = {};

export const userCards: CardDef<any>[] = Object.entries(modules).flatMap(([path, mod]) => {
  const found = Object.values(mod).filter(isCardDef);
  if (found.length === 0) {
    // 只警告不抛错:一张写坏的卡不该让整个编辑器起不来
    console.warn(`[cards/user] ${path} 里没有找到 CardDef 具名导出,已跳过`);
  }
  for (const def of found) userCardFileOf[def.id] = baseOf(path);
  return found;
});
