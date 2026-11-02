/**
 * Numeric controls in the mobile app panels: slider + number box, a row drawn from the card parameter
 * declarations. Shared by the adjustment panel and the filter row.
 */
import { useEffect, useRef, useState } from "react";
import type { Control } from "../kernel/types";

/** Slider + number box: while dragging only the display changes, the value is committed once on release (or Enter / blur in the number box), one drag = one undo step */
export function Slider(props: { label: string; value: number; min: number; max: number; step?: number; unit: string; onCommit: (v: number) => void; pcm?: string }) {
  const [v, setV] = useState(props.value);
  const range = useRef<HTMLInputElement>(null);
  useEffect(() => setV(props.value), [props.value]);
  const commit = (x: number) => { const c = Math.max(props.min, Math.min(props.max, x)); if (Math.abs(c - props.value) > 1e-9) props.onCommit(c); };
  useEffect(() => {
    const el = range.current;
    if (!el) return;
    const on = () => commit(Number(el.value));
    el.addEventListener("change", on);
    return () => el.removeEventListener("change", on);
  });
  return (
    <div className="field" data-pcm={props.pcm}>
      <label>{props.label}<span><input className="num" type="number" value={Math.round(v * 100) / 100} min={props.min} max={props.max} step={props.step ?? 1}
        onChange={(e) => setV(Number(e.target.value))} onBlur={() => commit(v)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /> {props.unit}</span></label>
      <input ref={range} type="range" min={props.min} max={props.max} step={props.step ?? 1} value={v} onChange={(e) => setV(Number(e.target.value))} />
    </div>
  );
}

export function ControlField({ ctl, value, onCommit }: { ctl: Control; value: unknown; onCommit: (v: unknown) => void }) {
  const [text, setText] = useState(String(value ?? ""));
  useEffect(() => setText(String(value ?? "")), [value]);
  if (ctl.type === "number" && ctl.min !== undefined && ctl.max !== undefined) {
    return <Slider label={ctl.label} value={Number(value ?? ctl.min)} min={ctl.min} max={ctl.max} step={ctl.step} unit="" onCommit={onCommit} />;
  }
  if (ctl.type === "select") {
    return (
      <div className="field"><label>{ctl.label}</label>
        <select className="text-in" value={String(value ?? "")} onChange={(e) => onCommit(e.target.value)}>
          {ctl.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    );
  }
  if (ctl.type === "color") {
    return <div className="field"><label>{ctl.label}<input type="color" value={String(value ?? "#ffffff")} onChange={(e) => onCommit(e.target.value)} /></label></div>;
  }
  const num = ctl.type === "number";
  return (
    <div className="field"><label>{ctl.label}</label>
      <input className="text-in" data-pcm={`param-${ctl.key}`} inputMode={num ? "decimal" : undefined} value={text} onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== String(value ?? "")) onCommit(num ? Number(text) : text); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
    </div>
  );
}
