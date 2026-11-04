/**
 * Small shared pieces of the mobile app UI: hint bubble, confirm dialog, bottom sheet (three drag tiers), sub-navigation bar.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { tr } from "../i18n/index.ts";

/* ---------------- Hint bubble ---------------- */

const ToastCtx = createContext<(text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const timer = useRef(0);
  const show = useCallback((t: string) => {
    setText(t);
    setSeq((n) => n + 1);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(null), 2000);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {text && <div key={seq} className="toast" role="status" data-pcm="toast">{text}</div>}
    </ToastCtx.Provider>
  );
}

/* ---------------- Confirm dialog ---------------- */

export interface ConfirmAsk { text: string; ok: string; danger?: boolean; run: () => void }
const ConfirmCtx = createContext<(ask: ConfirmAsk) => void>(() => {});
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmHost({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<ConfirmAsk | null>(null);
  return (
    <ConfirmCtx.Provider value={setAsk}>
      {children}
      {ask && (
        <div className="confirm" role="dialog" aria-modal="true" data-pcm="confirm">
          <div>
            <p>{ask.text}</p>
            <div className="acts">
              <button type="button" className="btn" onClick={() => setAsk(null)}>{tr("Cancel")}</button>
              <button type="button" className={ask.danger ? "btn danger" : "btn primary"} data-pcm="confirm-ok" onClick={() => { setAsk(null); ask.run(); }}>{ask.ok}</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}

/* ---------------- Bottom sheet ---------------- */

/**
 * A panel that pops up from the bottom. The title and category tabs stay fixed on top, and the content area scrolls vertically (scrolling to the end does not drag the page behind).
 * Press and drag the top handle or the panel header: dragging down past a certain distance = close, dragging up = expand to nearly full screen, and on release it snaps back to the nearest tier (closed / normal / expanded).
 */
export function Sheet(props: {
  id: string;
  title: ReactNode;
  tall?: boolean;
  light?: boolean;
  head?: ReactNode;
  tabs?: ReactNode;
  foot?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const drag = (e: React.PointerEvent) => {
    const sh = ref.current;
    if (!sh || (e.target as HTMLElement).closest("button")) return;
    const root = sh.parentElement!;
    const full = root.clientHeight - 8;
    const nat = expanded ? Number(sh.dataset.nat) : sh.offsetHeight;
    if (!expanded) sh.dataset.nat = String(nat);
    const base = expanded ? full : nat;
    const y0 = e.clientY;
    let v = base;
    sh.style.transition = "none";
    sh.style.maxHeight = "none";
    const mv = (ev: PointerEvent) => {
      v = Math.min(full, base - (ev.clientY - y0));
      if (v > nat) { sh.style.height = `${v}px`; sh.style.transform = "none"; }
      else { sh.style.height = `${nat}px`; sh.style.transform = `translateY(${nat - v}px)`; }
    };
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      sh.style.transition = "height .22s ease, transform .22s ease";
      if (v < nat - 80) {
        sh.style.transform = "translateY(105%)";
        window.setTimeout(props.onClose, 200);
      } else if (v > nat + 60) {
        sh.style.height = `${full}px`; sh.style.transform = ""; setExpanded(true); sh.dataset.state = "expanded";
      } else {
        sh.style.height = `${nat}px`; sh.style.transform = ""; setExpanded(false); sh.dataset.state = "";
        window.setTimeout(() => { if (sh.dataset.state !== "expanded") { sh.style.height = ""; sh.style.maxHeight = ""; sh.style.transition = ""; } }, 240);
      }
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return (
    <>
      <div className={props.light ? "scrim light" : "scrim"} data-pcm="scrim" onClick={props.onClose} />
      <div ref={ref} className={props.tall ? "sheet tall" : "sheet"} data-pcm={`sheet-${props.id}`}>
        <div className="grip" data-pcm="grip" onPointerDown={drag} />
        <div className="sheet-head" onPointerDown={drag}>
          <h3>{props.title}</h3>
          {props.head}
          <button type="button" className="icon-btn" aria-label={tr("Close")} onClick={props.onClose}><Icon name="close" /></button>
        </div>
        {props.tabs}
        <div className="sheet-body">{props.children}</div>
        {props.foot}
      </div>
    </>
  );
}

/* ---------------- Buttons overlaid on the stage ---------------- */

/**
 * The button overlaid on the preview image (the member button). Below the image is the cross-origin stage iframe, and Chrome sometimes hands the touch tap gesture to the iframe,
 * so the button receives pointerdown / pointerup but not the synthesized click (measured by probe on 2026-10-21); at other times it still sends the click as usual.
 * So on touch, wait a short moment after the finger lifts: if the click arrives, the click triggers; if not, the lift triggers, and it fires only once.
 * It does not fire at the moment of lifting: then, once the panel opens, the click sent afterward lands right on the newly appeared mask and closes the panel again (measured the same day in an account project).
 */
const CLICK_GRACE_MS = 350;
export function StageButton(props: { className?: string; pcm?: string; title?: string; onTap: () => void; children: ReactNode }) {
  const down = useRef<number | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={props.className}
      data-pcm={props.pcm}
      title={props.title}
      onPointerDown={(e) => { if (e.pointerType !== "mouse") down.current = e.pointerId; }}
      onPointerUp={(e) => {
        if (e.pointerType === "mouse" || down.current !== e.pointerId) return;
        down.current = null;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => { timer.current = 0; props.onTap(); }, CLICK_GRACE_MS);
      }}
      onPointerCancel={() => { down.current = null; }}
      onClick={() => { window.clearTimeout(timer.current); timer.current = 0; props.onTap(); }}
    >
      {props.children}
    </button>
  );
}

/* ---------------- Sub-navigation bar ---------------- */

export interface SubItem { icon: IconName; label: string; run: () => void; ref?: boolean; disabled?: boolean; pcm?: string; /** Hover hint when grayed out */ title?: string }

/** Sub-navigation bar: the thumbnail preview and the timeline share the same component; the content changes with the selected object, and scrolls back to the far left when the content changes */
export function SubNav({ items, pcm }: { items: SubItem[]; pcm: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = items.map((i) => i.label).join("|");
  useEffect(() => { if (ref.current) ref.current.scrollLeft = 0; }, [key]);
  return (
    <div ref={ref} className="subnav" data-pcm={pcm}>
      {items.map((it) => (
        <button key={it.label} type="button" className={it.ref ? "refbtn" : undefined} data-pcm={it.pcm} disabled={it.disabled} title={it.title} onClick={it.run}>
          <Icon name={it.icon} />{it.label}
        </button>
      ))}
    </div>
  );
}

/** Base color of thumbnail cards, media cells, and card cells: a fixed hue computed from the id (only so neighbors can be told apart, it does not represent the content) */
export function tint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 42% 34%)`;
}

/** Duration: 00:06 / 00:06.5 */
export function fmtDur(d: number): string {
  d = Math.round(d * 10) / 10;
  const m = Math.floor(d / 60), s = d - m * 60;
  const ss = Number.isInteger(s) ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  return `${String(m).padStart(2, "0")}:${ss}`;
}

/** Timecode: 00:00.0 */
export function fmtTc(t: number): string {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}
