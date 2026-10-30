import { useRef, useState, type KeyboardEvent } from "react";
import { STEP_BURST_MS, commitMerged, newGestureKey } from "./mergedEdit";
import { formatNumber, isTypingInput, reduceField, type FieldEvent } from "./numberDraft";

/**
 * 编辑面板里改项目内容的数字框(2026-10-20 用户定,`docs/semantics/workflow/editing.md`「撤销、重做」):
 * 在框里输入一个值只算一步改动、只记一步撤销,输入过程中的中间值不进项目。
 *
 *   - 敲字、粘贴、删除:只改本地草稿,不提交。
 *   - 回车、失去焦点:提交一次(`onCommit`)。回车同时让框失焦,这样 Ctrl+Z 马上能撤这一步。
 *   - Esc:放弃草稿,显示回项目里的值。
 *   - 输入是空的、半截(「-」)、不是数、`validate` 不认、或和显示的值一样:不提交,失焦后显示回项目里的值。
 *   - 上下方向键、输入框自带的上下箭头(浏览器给的是没有 inputType 的 input 事件):每一下立即提交,
 *     连续步进(相隔不超过 STEP_BURST_MS)并成一步撤销。
 *
 * `onCommit` 收到的是已经确认过的有限数;夹到范围、校验、报错由调用方做(和以前一样)。
 * `value` 不是有限数(参数没有值)时显示空,配 `placeholder`。
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
  /** 显示最多几位小数,默认 3 */
  digits?: number;
  /** 不认的数当没输入处理(例如框的宽高必须大于 0) */
  validate?: (n: number) => boolean;
  /** 其余要原样写到 input 上的属性(`data-pc`、`aria-label`、`title`…) */
  attrs?: Record<string, string>;
}

export function NumberField({ value, onCommit, step, min, max, disabled, placeholder, className, digits, validate, attrs }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const burstKey = useRef<string>("");
  if (!burstKey.current) burstKey.current = newGestureKey("number-step");

  /** 逐事件交给状态机(numberDraft.ts 的 reduceField),它决定草稿怎么变、要不要提交 */
  const dispatch = (ev: FieldEvent, input?: HTMLInputElement) => {
    const out = reduceField(draft, ev, { value, validate, digits });
    setDraft(out.draft);
    if (out.commit) {
      const v = out.commit.value;
      if (out.commit.step) commitMerged(burstKey.current, STEP_BURST_MS, () => onCommit(v));
      else onCommit(v);
    }
    if (out.blur) input?.blur(); // 失焦事件随后到,提交在那里
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
