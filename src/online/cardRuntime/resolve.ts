/**
 * 卡片源码里一个导入接到哪里(`docs/plan/online-card-exec-contract.md` 第 2 节)。纯函数,不读文件。
 *
 * | 写法 | 接到 |
 * |---|---|
 * | 白名单里的包名 | 页面自带的那一份 |
 * | 相对导入,落在用户卡目录下、内容库里有 | 同步来的源码(`.css` 是样式,不执行) |
 * | 相对导入,落在页面自带的内置模块上 | 页面那一份 |
 * | 其余 | 不支持:`{ ok: false }`,调用方报「引用了在线页面里没有的模块」 |
 *
 * 内置模块的范围:`src/cards/`(用户卡目录除外)、`src/parts/`、`src/kernel/`,以及 `src/render/cards/graphValues.ts`。
 * 范围之外的(例如 `src/editor/`、`src/store/`)即使页面里有也不给引。
 */
import { CARD_PACKAGES, type ResolvedImport } from "./protocol.ts";

export const USER_CARD_DIR = "src/cards/user/";
const BUILTIN_PREFIXES = ["src/cards/", "src/parts/", "src/kernel/"];
const BUILTIN_FILES = new Set(["src/render/cards/graphValues.ts"]);
/** 相对导入补的扩展名(先后同 Vite) */
const MODULE_EXTS = [".ts", ".tsx", ".mjs", ".js"];

export interface ResolveEnv {
  /** 内容库的列表里有没有这个键 */
  hasSynced: (key: string) => boolean;
  /** 页面自带的内置模块表里有没有这个路径 */
  hasBuiltin: (path: string) => boolean;
}

export type ResolveOutcome = { ok: true; to: ResolvedImport } | { ok: false; reason: string };

/** 这个路径在不在卡片可以引的内置模块范围里 */
export function isBuiltinModulePath(path: string): boolean {
  if (path.startsWith(USER_CARD_DIR)) return false;
  if (/\.test\.(ts|tsx|mjs|js)$/.test(path)) return false;
  if (BUILTIN_FILES.has(path)) return true;
  return BUILTIN_PREFIXES.some((p) => path.startsWith(p)) && /\.(tsx?|mjs|js)$/.test(path);
}

/** `fromKey` 所在目录下的相对说明符 → 仓库相对路径(不补扩展名);爬出仓库根回 null */
function join(fromKey: string, spec: string): string | null {
  const parts = fromKey.split("/").slice(0, -1);
  for (const p of spec.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.length ? parts.join("/") : null;
}

function candidates(base: string): string[] {
  if (/\.(tsx?|mjs|js)$/.test(base)) {
    const stem = base.replace(/\.(tsx?|mjs|js)$/, "");
    return [...new Set([base, ...MODULE_EXTS.map((e) => stem + e)])];
  }
  return [...MODULE_EXTS.map((e) => base + e), `${base}/index.ts`, `${base}/index.tsx`];
}

export function resolveCardImport(fromKey: string, spec: string, env: ResolveEnv): ResolveOutcome {
  if (typeof spec !== "string" || !spec) return { ok: false, reason: "空的导入" };
  if (!(spec.startsWith("./") || spec.startsWith("../"))) {
    if (CARD_PACKAGES.includes(spec)) return { ok: true, to: { kind: "package", name: spec } };
    return { ok: false, reason: spec };
  }
  if (spec.includes("?") || spec.includes("\\") || spec.includes("#")) return { ok: false, reason: spec };
  const base = join(fromKey, spec);
  if (!base) return { ok: false, reason: spec };
  if (base.endsWith(".css")) {
    if (base.startsWith(USER_CARD_DIR) && env.hasSynced(base)) return { ok: true, to: { kind: "style", key: base } };
    return { ok: false, reason: spec };
  }
  // 资源导入(.json、.png、.svg……)没有对应的候选文件,落到最后的「不支持」
  for (const c of candidates(base)) {
    if (c.startsWith(USER_CARD_DIR)) {
      if (env.hasSynced(c)) return { ok: true, to: { kind: "synced", key: c } };
      continue;
    }
    if (isBuiltinModulePath(c) && env.hasBuiltin(c)) return { ok: true, to: { kind: "builtin", path: c } };
  }
  return { ok: false, reason: spec };
}
