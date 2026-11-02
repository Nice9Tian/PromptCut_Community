import type { CardDef, Control } from "./types";
import { allCards } from "./registry.ts";

/**
 * Validation for card parameters.
 *
 * Why it is needed: clip.params is a sparse overlay layer, merged with CardDef.defaults only
 * during rendering (see Stage.tsx). This design makes "unspecified parameters use defaults" very
 * natural, but also means **incorrect parameters will not throw errors**: misspelled key names are
 * treated as unwritten, and missing key parameters play defaults. The caption track once played
 * three lines of demo copy as user captions because of this, without throwing an error anywhere.
 *
 * So errors are blocked at the MCP layer (the required path for AI card creation and edits):
 * unrecognized key names, empty required fields, select values not in options: all throw errors
 * directly and indicate the correct values, letting the AI know immediately where the error is
 * rather than waiting for the user to notice on screen.
 */

export function findCard(cardId: string): CardDef<any> {
  const card = allCards().find((c) => c.id === cardId);
  if (!card) {
    const ids = allCards().map((c) => c.id).join(", ");
    throw new Error(`No card with id "${cardId}". Available card ids: ${ids}`);
  }
  return card;
}

/**
 * Whether a control is considered to have "filled-in content". Empty strings and pure whitespace
 * both count as unfilled.
 */
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
 * Validate a parameter write.
 *
 * @param patch     Parameters to write this time (sparse)
 * @param existing  Existing parameters on clip; empty when creating a new card
 * @returns         Complete parameters after merging defaults and existing, for caller reference
 *
 * Validates the **merged** result: when changing the color of a caption card that already has lines
 * filled in, it should not report "required field cannot be empty" just because this patch omits
 * lines.
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
      // Misspelled key names are the most common silent failure: during merging it is merely an extra
      // entry that nobody reads.
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
