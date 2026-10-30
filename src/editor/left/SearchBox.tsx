import type { RefObject } from "react";
import { IconClose, IconSearch } from "../../ui/icons";

/** 分区头部的搜索框:放大镜 + 输入框 + 有字时出现的清空钮。Esc 也能清空 */
export function SearchBox({
  value,
  onChange,
  placeholder,
  dataPc,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** 自动化钩子,沿用改版前的名字(search / effects-search / caption-search) */
  dataPc: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <label className="pc-left-search">
      <IconSearch size={14} />
      <input
        ref={inputRef}
        data-pc={dataPc}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onChange("");
          }
        }}
      />
      {value && (
        <button type="button" className="pc-left-search-clear" onClick={() => onChange("")} title="清空">
          <IconClose size={12} />
        </button>
      )}
    </label>
  );
}
