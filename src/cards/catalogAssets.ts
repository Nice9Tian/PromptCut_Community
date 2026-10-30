/**
 * 动效素材目录:server/catalog 下现成的 Lottie 动画和 tsParticles 配置。
 *
 * 文件本身早就随包发出去了(runtime/app/server/catalog),但以前软件里没有任何地方
 * 把它们列出来 —— 左栏素材面板不显示、list_cards 不提、参数表单是个纯文本框,
 * 用户和 AI 都得自己知道 `/catalog/<kind>/<name>.json` 这种路径才用得上。
 *
 * 这里把两份 index.json 在构建时读进来(vite 直接 import JSON),给三处用:
 *   - Lottie 卡的 src、粒子卡的 config 两个控件变成 `asset` 类型,options 就是这份目录,
 *     list_cards 原样返回 controls,AI 不用再翻建卡指南就能看到有哪些素材;
 *   - 左栏素材面板多一组「动效素材」,点一下 / 拖到时间轴就是带好 URL 的卡;
 *   - 参数表单给这两个控件一个下拉,手填仍然保留。
 *
 * 只读 index.json 里登记过的条目;服务端 /catalog 路由也只放行这些名字。
 */
import lottieIndex from "../../server/catalog/lottie/index.json";
import particlesIndex from "../../server/catalog/particles/index.json";

export type AssetKind = "lottie" | "particles";

export interface CatalogAsset {
  kind: AssetKind;
  name: string;
  /** 同源 URL,直接填进卡片参数 */
  url: string;
  description: string;
  /** 模型看过画面后写的观察,比 description 具体 */
  note?: string;
  /** 建议的使用场合 */
  use?: string;
  tags: string[];
  /** Lottie 才有:动画本身的时长 / 画布尺寸 */
  seconds?: number;
  w?: number;
  h?: number;
  featured?: boolean;
}

interface RawItem {
  name: string;
  url: string;
  description?: string;
  note?: string;
  use?: string;
  tags?: string[];
  seconds?: number;
  w?: number;
  h?: number;
  featured?: boolean;
}

function normalize(kind: AssetKind, items: RawItem[]): CatalogAsset[] {
  return items
    .filter((it) => it && typeof it.name === "string" && typeof it.url === "string")
    .map((it) => ({
      kind,
      name: it.name,
      url: it.url,
      description: it.description ?? "",
      note: it.note,
      use: it.use,
      tags: it.tags ?? [],
      seconds: it.seconds,
      w: it.w,
      h: it.h,
      featured: it.featured,
    }));
}

export const lottieAssets: CatalogAsset[] = normalize("lottie", (lottieIndex as { items: RawItem[] }).items);
export const particleAssets: CatalogAsset[] = normalize("particles", (particlesIndex as { items: RawItem[] }).items);

export function assetsOf(kind: AssetKind): CatalogAsset[] {
  return kind === "lottie" ? lottieAssets : particleAssets;
}

/**
 * 素材所属的卡和参数名:选中一个素材要往哪张卡的哪个参数里填 URL。
 * extra 是同时要清掉的东西:Lottie 卡的 json(内联文本)优先级高于 src,默认值又是一段演示动画,
 * 只填 src 不清 json 的话播出来的还是演示 —— 实测踩过。
 */
export const ASSET_TARGET: Record<AssetKind, { cardId: string; paramKey: string; extra: Record<string, unknown> }> = {
  lottie: { cardId: "lottie", paramKey: "src", extra: { json: "" } },
  particles: { cardId: "particles", paramKey: "config", extra: {} },
};

/** 选中一个素材后要写进 clip 的参数 */
export function assetParams(a: CatalogAsset): Record<string, unknown> {
  const t = ASSET_TARGET[a.kind];
  return { ...t.extra, [t.paramKey]: a.url };
}

/** 一行能读懂的标签:名字 + 说明(下拉框和 list_cards 里都用它) */
export function assetLabel(a: CatalogAsset): string {
  const extra = a.kind === "lottie" && a.seconds ? `,${a.seconds}s` : "";
  return `${a.name} — ${a.description || a.note || ""}${extra}`;
}

/** 给 `asset` 控件的 options。value 是 URL,填进参数就能用 */
export function assetOptions(kind: AssetKind): { value: string; label: string }[] {
  return assetsOf(kind).map((a) => ({ value: a.url, label: assetLabel(a) }));
}

/** 按 URL 反查(参数表单显示当前选的是哪个) */
export function findAssetByUrl(kind: AssetKind, url: string): CatalogAsset | undefined {
  return assetsOf(kind).find((a) => a.url === url);
}
