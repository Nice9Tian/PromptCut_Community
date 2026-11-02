import type { CardDef, Control } from "./types";
import { allCards } from "./registry.ts";

/**
 * 卡片参数的校验。
 *
 * 为什么需要它:clip.params 是稀疏覆盖层,渲染时才和 CardDef.defaults 合并
 * (见 Stage.tsx)。这个设计让「不写的参数用默认值」很自然,但也意味着
 * **参数写错了不会报错** —— 键名拼错就当没写、缺了关键参数就播默认值。
 * 字幕轨曾经因此把三行演示文案当成用户字幕播出去,而没有任何一处报错。
 *
 * 所以在 MCP 这一层(AI 建卡改卡的必经之路)把错误挡住:键名不认识、
 * 必填项为空、select 取值不在选项里 —— 都直接抛错并告诉它正确的取值,
 * 让 AI 当场知道错在哪,而不是等用户看画面才发现。
 */

export function findCard(cardId: string): CardDef<any> {
  const card = allCards().find((c) => c.id === cardId);
  if (!card) {
    const ids = allCards().map((c) => c.id).join(", ");
    throw new Error(`No card with id "${cardId}". Available card ids: ${ids}`);
  }
  return card;
}

/** 控件是否算「填了东西」。空串和纯空白都算没填。 */
function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function describeControl(c: Control): string {
  const bits = [`${c.key}(${c.label},${c.type}`];
  if (c.type === "select") bits.push(`values ${c.options.map((o) => o.value).join("/")}`);
  if (c.type === "asset") bits.push(`URLs from the asset catalog (${c.options.length} items, see options in controls), or any other URL or inline JSON`);
  if (c.required) bits.push("required");
  return bits.join(",") + ")";
}

/**
 * 校验一次参数写入。
 *
 * @param patch     这次要写进去的参数(稀疏)
 * @param existing  clip 上已有的参数;新建卡时留空
 * @returns         合并了 defaults 和 existing 之后的完整参数,供调用方参考
 *
 * 校验的是**合并后**的结果:改一张已经填好 lines 的字幕卡的颜色时,
 * 不该因为这次 patch 里没带 lines 就报「必填项为空」。
 */
export function validateCardParams(
  cardId: string,
  patch: Record<string, unknown> | undefined,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const card = findCard(cardId);
  const known = new Map(card.controls.map((c) => [c.key, c]));
  const problems: string[] = [];

  for (const [key, value] of Object.entries(patch || {})) {
    const control = known.get(key);
    if (!control) {
      // 键名写错是最常见的静默失败:合并时它只是多出来的一项,谁也不读。
      problems.push(`Parameter "${key}" is not a parameter of ${cardId}. It accepts: ${card.controls.map(describeControl).join(", ")}`);
      continue;
    }
    if (control.type === "number" && typeof value !== "number") {
      problems.push(`Parameter "${key}" needs a number, got ${JSON.stringify(value)}`);
    }
    if (control.type === "select" && !control.options.some((o) => o.value === value)) {
      problems.push(`Parameter "${key}" can only be ${control.options.map((o) => o.value).join(" / ")}, got ${JSON.stringify(value)}`);
    }
  }

  const merged = { ...card.defaults, ...(existing || {}), ...(patch || {}) };

  for (const control of card.controls) {
    if (control.required && !isFilled(merged[control.key])) {
      problems.push(
        `"${control.key}" (${control.label}) of ${cardId} is required and cannot be empty.` +
          (control.hint ? `${control.hint}` : ""),
      );
    }
  }

  if (problems.length > 0) throw new Error(problems.join("\n"));
  return merged;
}
