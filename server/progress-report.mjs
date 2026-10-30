/**
 * 进度报告校验模块
 * 供服务端 report_progress 工具使用，验证、规范化和截断 AI 提交的进度报告。
 *
 * 只拒收真正用不了的参数:
 * - has_done / has_todo / has_problem 是让模型自查的冗余字段,不看,按数组重新算;
 * - final / stage / 三个数组缺省或为 null 都按「没给」处理 —— OpenAI、Gemini 风格的函数调用
 *   常把可选字段填成 null,为这个拒收只会让 Agent 原样重发一遍。
 * 界面(src/ai/progressReport.ts)用同一套规则解析调用参数。CLI 驱动报回来的工具结果分不出拒收,
 * 两边规则不一致的话,界面会把拒收的那次也画成卡片,用户看到两张一样的。
 */
export function validateProgressReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '参数应为对象' };
  }

  // 报错里写「收到的是什么」:typeof 会把 null 和数组都说成 object,Agent 看了没法照着改
  const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const given = (v) => v !== undefined && v !== null;

  if (given(input.final) && typeof input.final !== 'boolean') {
    return { ok: false, error: `字段 final 应该是布尔值 (boolean),收到的是 ${kindOf(input.final)}` };
  }

  if (given(input.blocked) && typeof input.blocked !== 'boolean') {
    return { ok: false, error: `字段 blocked 应该是布尔值 (boolean),收到的是 ${kindOf(input.blocked)}` };
  }

  if (given(input.stage) && typeof input.stage !== 'string') {
    return { ok: false, error: `字段 stage 应该是字符串 (string),收到的是 ${kindOf(input.stage)}` };
  }

  const normalizeArray = (arr, name) => {
    if (!given(arr)) return { value: [] };
    if (!Array.isArray(arr)) {
      return { error: `字段 ${name} 应该是字符串数组 (array),收到的是 ${kindOf(arr)}` };
    }
    const result = [];
    for (const [idx, item] of arr.entries()) {
      if (typeof item !== 'string') {
        return { error: `字段 ${name} 的第 ${idx + 1} 条应为字符串,收到的是 ${kindOf(item)}` };
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
    return { ok: false, error: '报告是空的:done / todo / problems 至少填一条,或者给出 final(true 表示整个任务收尾)' };
  }

  /*
   * blocked:停下来等用户回话。它**隐含** final —— 停在这里就是这一轮结束了,
   * 所以 blocked 为 true 而 final 漏填(或填了 false)时按 final 算,不为这个拒收:
   * 拒一次要白费一个往返,而丢掉这一位,用户就不知道球在他那边(界面会画成「已暂停」)。
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
      value.stage = Array.from(trimmedStage).slice(0, 12).join(''); // 最多截取 12 个字符
    }
  }

  return { ok: true, value };
}
