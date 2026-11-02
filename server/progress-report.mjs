/**
 * Progress report validation module
 * Used by the server-side report_progress tool to validate, normalize, and truncate progress
 * reports submitted by AI.
 *
 * Only rejects parameters that are genuinely unusable:
 * - has_done / has_todo / has_problem are redundant fields for model self-check; ignored,
 *   recomputed from arrays;
 * - final / stage / the three arrays omitted or null are treated as "not provided": OpenAI- and
 *   Gemini-style function calls often populate optional fields with null, and rejecting for this
 *   only causes the Agent to resend the exact same payload.
 * The UI (src/ai/progressReport.ts) parses invocation parameters using the same rules. Tool results
 * reported back by the CLI driver cannot distinguish rejections; if rules diverge between the two
 * sides, the UI will also render the rejected attempt as a card, showing the user two identical cards.
 */
export function validateProgressReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Arguments must be an object' };
  }

  // State "what was received" in errors: typeof reports both null and arrays as object, so the Agent cannot fix it accordingly
  const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const given = (v) => v !== undefined && v !== null;

  if (given(input.final) && typeof input.final !== 'boolean') {
    return { ok: false, error: `Field final must be a boolean, got ${kindOf(input.final)}` };
  }

  if (given(input.blocked) && typeof input.blocked !== 'boolean') {
    return { ok: false, error: `Field blocked must be a boolean, got ${kindOf(input.blocked)}` };
  }

  if (given(input.stage) && typeof input.stage !== 'string') {
    return { ok: false, error: `Field stage must be a string, got ${kindOf(input.stage)}` };
  }

  const normalizeArray = (arr, name) => {
    if (!given(arr)) return { value: [] };
    if (!Array.isArray(arr)) {
      return { error: `Field ${name} must be an array of strings, got ${kindOf(arr)}` };
    }
    const result = [];
    for (const [idx, item] of arr.entries()) {
      if (typeof item !== 'string') {
        return { error: `Item ${idx + 1} of field ${name} must be a string, got ${kindOf(item)}` };
      }
      const trimmed = item.trim();
      if (trimmed !== '') {
        result.push(Array.from(trimmed).slice(0, 60).join(''));
      }
    }
    return { value: result.slice(0, 8) };
  };

  const doneRes = normalizeArray(input.done, 'done');
  if (doneRes.error) return { ok: false, error: doneRes.error };
  const done = doneRes.value;

  const todoRes = normalizeArray(input.todo, 'todo');
  if (todoRes.error) return { ok: false, error: todoRes.error };
  const todo = todoRes.value;

  const problemsRes = normalizeArray(input.problems, 'problems');
  if (problemsRes.error) return { ok: false, error: problemsRes.error };
  const problems = problemsRes.value;

  if (!done.length && !todo.length && !problems.length && typeof input.final !== 'boolean') {
    return { ok: false, error: 'The report is empty: fill in at least one of done / todo / problems, or give final (true means the whole task is finished)' };
  }

  /*
   * blocked: stops to wait for user reply. It **implies** final: stopping here means this round has
   * ended, so when blocked is true and final is omitted (or set to false), treat it as final rather
   * than rejecting for this: rejecting once wastes a round trip, while dropping this bit means the
   * user does not know the ball is in their court (the UI would render it as "Paused").
   */
  const blocked = input.blocked === true;
  const value = {
    final: input.final === true || blocked,
    ...(blocked ? { blocked: true } : {}),
    has_done: done.length > 0,
    has_todo: todo.length > 0,
    has_problem: problems.length > 0,
    done,
    todo,
    problems
  };

  if (typeof input.stage === 'string') {
    const trimmedStage = input.stage.trim();
    if (trimmedStage !== '') {
      value.stage = Array.from(trimmedStage).slice(0, 12).join(''); // Truncate to at most 12 characters
    }
  }

  return { ok: true, value };
}
