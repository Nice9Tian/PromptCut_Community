/**
 * 字体指纹(I0)—— 共享快照键(A3a)里代表「这台机器当时手上有哪些字体」的那一项。
 *
 * 定义:`document.fonts` 里**已加载**(`status === 'loaded'`)的 family 名,
 * 去重、排序、换行拼接,再哈希。为什么是这三步:
 *   - 只取已加载的:声明了但没真正下下来的 @font-face 不影响这一帧的排版;
 *   - 去重:同一个 family 的多个字重/字形是多个 FontFace,但排版落到的是同一族;
 *   - 排序:FontFaceSet 的迭代顺序跟加载先后有关,不排序两台机器必然算出不同的键。
 *
 * 用同步哈希(FNV-1a 两轮,16 位十六进制)而不是 `crypto.subtle.digest`:
 * 这个值要在 `window.__pcCardPlan()` 这种同步取值里返回,`subtle` 是异步的。
 * 它不做安全用途,只要跨机器确定、碰撞概率低到可以忽略即可。
 */
export interface FontLike {
  family: string;
  status: string;
}

/** 已加载的 family 名:去重 + 排序。键里真正被哈希的就是这个列表。 */
export function fontFamilyNames(fonts: Iterable<FontLike> | null | undefined): string[] {
  const names = new Set<string>();
  if (fonts && typeof (fonts as any)[Symbol.iterator] === "function") {
    for (const font of fonts) {
      if (!font || font.status !== "loaded") continue;
      const family = String(font.family ?? "").trim();
      if (family) names.add(family);
    }
  }
  return [...names].sort();
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 纯函数,不碰 `document` —— 舞台页、导出页和测试各自把自己的 FontFaceSet 递进来。
 * 一个字体都没加载时返回的是空列表的哈希(一个确定值),不是空串:
 * 「没有字体」和「没算过」必须是两件事。
 */
export function fontFingerprintOf(fonts: Iterable<FontLike> | null | undefined): string {
  // 每个族名先 JSON 转义再拼:直接 join("\n") 的话,族名里本来就带换行的一个字体
  // 会和两个字体拼出同一个串(`new FontFace("A\nB", …)` 是合法的)。
  const list = fontFamilyNames(fonts).map(name => JSON.stringify(name)).join("\n");
  return fnv1a(list, 0x811c9dc5) + fnv1a(list, 0x9e3779b9);
}
