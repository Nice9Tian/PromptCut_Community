import { useRef, useState, type KeyboardEvent } from "react";
import { STEP_BURST_MS, commitMerged, newGestureKey } from "./mergedEdit";
import { formatNumber, isTypingInput, reduceField, type FieldEvent } from "./numberDraft";

/**
 * Number field for editing project content in the editor panel (user decision, 2026-10-20, `docs/semantics/workflow/editing.md` "Undo, redo"):
 * entering a value in the field counts as one change and records one undo step; intermediate values while typing do not enter the project.
 *
 *   - Typing, pasting, deleting: only change the local draft, no commit.
 *   - Enter, losing focus: commit once (`onCommit`). Enter also blurs the field, so Ctrl+Z can undo this step right away.
 *   - Esc: discard the draft and show the project value again.
 *   - Input is empty, half-typed ("-"), not a number, rejected by `validate`, or equal to the displayed value: no commit,
 *     and after blur the project value is shown again.
 *   - Up/down arrow keys and the input's built-in up/down arrows (the browser sends an input event without inputType):
 *     each press commits immediately, and consecutive steps (no more than STEP_BURST_MS apart) merge into one undo step.
 *
 * `onCommit` receives an already confirmed finite number; clamping to range, validation and error reporting are done by the caller (as before).
 * When `value` is not a finite number (the parameter has no value), the field is shown empty, with `placeholder`.
 */
export interface NumberFieldProps {
  value: number | null | undefined;
  onCommit: (n: number) => void;
  step?: number | string;
  min?: number;
  max?: number;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Maximum number of decimals to display, default 3 */
  digits?: number;
  /** A rejected number is treated as no input (for example, the width and height of a box must be greater than 0) */
  validate?: (n: number) => boolean;
  /** Other attributes to write onto the input as they are (`data-pc`, `aria-label`, `title`…) */
  attrs?: Record<string, string>;
}

export function NumberField({ value, onCommit, step, min, max, disabled, placeholder, className, digits, validate, attrs }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const burstKey = useRef<string>("");
  if (!burstKey.current) burstKey.current = newGestureKey("number-step");

  /** Hand each event to the state machine (reduceField in numberDraft.ts), which decides how the draft changes and whether to commit */
  const dispatch = (ev: FieldEvent, input?: HTMLInputElement) => {
    const out = reduceField(draft, ev, { value, validate, digits });
    setDraft(out.draft);
    if (out.commit) {
      const v = out.commit.value;
      if (out.commit.step) commitMerged(burstKey.current, STEP_BURST_MS, () => onCommit(v));
      else onCommit(v);
    }
    if (out.blur) input?.blur(); // The blur event arrives next, and the commit happens there
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") dispatch({ type: "enter" }, e.currentTarget);
    else if (e.key === "Escape" && draft !== null) {
      e.preventDefault();
      dispatch({ type: "escape" });
    }
  };

  return (
    <input
      {...attrs}
      type="number"
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
      value={draft ?? formatNumber(value, digits)}
      onChange={(e) => dispatch({ type: "input", raw: e.target.value, typing: isTypingInput((e.nativeEvent as InputEvent).inputType) })}
      onBlur={() => dispatch({ type: "blur" })}
      onKeyDown={onKeyDown}
    />
  );
}
