/**
 * Cuts a "thinking" text into **step titles**.
 *
 * # Why
 *
 * Some models, via a relay service, send back a `<think>` that holds not a chain of thought but a
 * one-line step name:
 *
 *   **Clarifying article link and scope**
 *   **Requesting missing webpage link**
 *   **Planning non-destructive timeline design**
 *
 * Short, bold, verb-first: this is text for a progress bar, not reasoning meant to be read. Spreading
 * the whole thing as is in the bubble pushes the body text apart; while hiding it behind the "Show
 * thinking" switch is as good as nothing, since the user cannot see what it is doing.
 * So it is extracted into step lines, and handed to the UI to make a ticker-style progress display.
 *
 * # Rules
 *
 * If there is `**bold**`, extract by bold; however many there are in a passage is however many steps
 * (the model often emits two or three at a time).
 *
 * When there is no bold, **be careful**: that is mostly a real chain of thought (Claude Code / Codex
 * use their own thinking channel and emit whole passages of reasoning). Truncating the first line
 * of a piece of reasoning to 48 characters and hanging it up gives a fragment with no head or tail,
 * which is worse than showing nothing. So only text that "is short to begin with and has only one
 * line" counts as a step: only a title can have that shape.
 * Everything else returns empty and goes down the "Show thinking" path as before.
 */

/**
 * A step title is shown at most this long and truncated beyond that. Anything longer is not a step
 * name, and spreading it out would break the bubble
 */
const MAX_LEN = 48;
/** With no bold, the whole passage is treated as a step name only if it is shorter than this length */
const BARE_STEP_MAX = 40;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN - 1) + "…" : t;
}

/**
 * @param text the original text of one think passage
 * @returns the step titles in order of appearance; an empty array when there is nothing to show
 */
export function thinkingSteps(text: string): string[] {
  const s = String(text ?? "");
  if (!s.trim()) return [];

  const bold: string[] = [];
  // Newlines are allowed inside a title (the model occasionally wraps a long title), but with an upper
  // limit of 200 characters: if a stray `**` appears, it must not eat all the way to the end of the
  // text. Non-greedy plus the limit is safe enough.
  const re = /\*\*([^*][\s\S]{0,200}?)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const t = clip(m[1]);
    if (t) bold.push(t);
  }
  if (bold.length) return bold;

  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length !== 1) return [];          // Multiple lines = reasoning, not a title
  if (lines[0].length > BARE_STEP_MAX) return []; // Long = reasoning, not a title
  return [clip(lines[0])];
}

/**
 * The step list combined from all think passages in a message; the order is kept and adjacent
 * duplicates are merged
 */
export function stepsOfThinking(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const step of thinkingSteps(t)) {
      if (out[out.length - 1] !== step) out.push(step);
    }
  }
  return out;
}

/**
 * The step a message has reached at this moment: the last step title among all think passages.
 *
 * The thinking strip above the input box shows only this one line. It used to be the whole series
 * of steps stacked vertically in the bubble, which after dozens of steps made the bubble very long,
 * and "now", the thing you actually want to see, sank to the very bottom.
 *
 * Only parts with kind === "thinking" are recognized; text, tool and status parts are all skipped.
 * When there is no step to show (no thinking, or the thinking is a whole passage of reasoning) it
 * returns null, and the caller falls back to "which tool is running".
 */
export function currentStep(parts: ReadonlyArray<{ kind: string; text?: string }>): string | null {
  const texts: string[] = [];
  for (const p of parts || []) {
    if (p.kind === "thinking" && typeof p.text === "string") texts.push(p.text);
  }
  const steps = stepsOfThinking(texts);
  return steps.length ? steps[steps.length - 1] : null;
}
