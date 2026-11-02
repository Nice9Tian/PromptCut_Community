/**
 * Draft rules for the number field (pure functions, used by `NumberField.tsx` and driven directly by `numberDraft.test.mjs`).
 *
 * Typing in the number field only changes the draft, not the project; only on Enter or blur do these rules decide
 * between committing and reverting.
 * For semantics see `docs/semantics/workflow/editing.md` "Undo, redo" (user decision, 2026-10-20).
 */

/** How a value in the project is displayed (at most `digits` decimals; shown empty if not a finite number) */
export function formatNumber(v: number | null | undefined, digits = 3): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  return String(Number(v.toFixed(digits)));
}

export type SettleResult = { kind: "commit"; value: number } | { kind: "revert" };

/**
 * Finalize the draft:
 * - empty, a half-typed fragment like "-" or ".", not a finite number, or rejected by `validate` → revert (no commit);
 * - same as the currently displayed value (the user changed nothing) → revert (no commit, so 0.30000004 is not silently changed to 0.3);
 * - otherwise → commit this number.
 */
export function settleDraft(draft: string, current: number | null | undefined, opts: { validate?: (n: number) => boolean; digits?: number } = {}): SettleResult {
  const text = draft.trim();
  if (text === "") return { kind: "revert" };
  const n = Number(text);
  if (!Number.isFinite(n)) return { kind: "revert" };
  if (opts.validate && !opts.validate(n)) return { kind: "revert" };
  const shown = formatNumber(current, opts.digits ?? 3);
  if (shown !== "" && Number(shown) === n) return { kind: "revert" };
  return { kind: "commit", value: n };
}

/**
 * Whether an `input` event is the user typing. In Chrome / Firefox, the InputEvent for typing, pasting and deleting carries `inputType`,
 * while arrow keys and the input's built-in up/down arrow stepping fire a plain input event without `inputType`.
 */
export function isTypingInput(inputType: unknown): boolean {
  return typeof inputType === "string" && inputType !== "";
}

/* ---------------- Number field state machine ---------------- */

/** Event received by the number field */
export type FieldEvent =
  /** `typing`: the user is typing / pasting / deleting (see isTypingInput); otherwise it is arrow-key or up/down arrow stepping */
  | { type: "input"; raw: string; typing: boolean }
  | { type: "blur" }
  | { type: "enter" }
  | { type: "escape" };

export interface FieldStep {
  /** The draft after the event; null = no draft, show the value in the project */
  draft: string | null;
  /** The number to commit. `step` = comes from stepping (consecutive steps merge into one undo step); otherwise it is a single commit on Enter / blur */
  commit?: { value: number; step: boolean };
  /** Blur the input (Enter): the blur event arrives next, and the commit happens there */
  blur?: boolean;
}

/**
 * One event goes in, the draft and the actions to take come out (`NumberField.tsx` calls it per event, unit tests drive it directly):
 * typing only changes the draft; stepping commits immediately; Enter → blur; blur → finalize the draft (commit or revert); Esc → discard the draft.
 */
export function reduceField(draft: string | null, ev: FieldEvent, ctx: { value: number | null | undefined; validate?: (n: number) => boolean; digits?: number }): FieldStep {
  switch (ev.type) {
    case "input": {
      if (ev.typing) return { draft: ev.raw };
      const r = settleDraft(ev.raw, ctx.value, ctx);
      return r.kind === "commit" ? { draft: null, commit: { value: r.value, step: true } } : { draft: null };
    }
    case "enter":
      return { draft, blur: true };
    case "escape":
      return { draft: null };
    case "blur": {
      if (draft === null) return { draft: null };
      const r = settleDraft(draft, ctx.value, ctx);
      return r.kind === "commit" ? { draft: null, commit: { value: r.value, step: false } } : { draft: null };
    }
  }
}
