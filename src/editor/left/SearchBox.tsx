import type { RefObject } from "react";
import { IconClose, IconSearch } from "../../ui/icons";
import { tr } from "../../i18n/index.ts";

/** Search box in a section head: magnifier + input + a clear button that appears when there is text. Esc also clears */
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
  /** Automation hook, keeping the names from before the redesign (search / effects-search / caption-search) */
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
        <button type="button" className="pc-left-search-clear" onClick={() => onChange("")} title={tr("Clear")}>
          <IconClose size={12} />
        </button>
      )}
    </label>
  );
}
