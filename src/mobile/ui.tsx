/**
 * 手机版界面共用的小件:提示气泡、确认框、底部面板(三档拖动)、子导航栏。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/* ---------------- 提示气泡 ---------------- */

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

/* ---------------- 确认框 ---------------- */

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
              <button type="button" className="btn" onClick={() => setAsk(null)}>取消</button>
              <button type="button" className={ask.danger ? "btn danger" : "btn primary"} data-pcm="confirm-ok" onClick={() => { setAsk(null); ask.run(); }}>{ask.ok}</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}

/* ---------------- 底部面板 ---------------- */

/**
 * 从底部弹出的面板。标题和分类标签固定在上面,内容区上下滑动(滚到头不带动后面的页面)。
 * 按住顶部横杠或面板头部拖:往下拖过一定距离 = 关闭,往上拖 = 展开到接近全屏,松手回弹到最近的一档(关闭 / 正常 / 展开)。
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
          <button type="button" className="icon-btn" aria-label="关闭" onClick={props.onClose}><Icon name="close" /></button>
        </div>
        {props.tabs}
        <div className="sheet-body">{props.children}</div>
        {props.foot}
      </div>
    </>
  );
}

/* ---------------- 叠在舞台上的按钮 ---------------- */

/**
 * 叠在预览画面上的按钮(成员按钮)。画面下面是跨源的舞台 iframe,Chrome 有时把触屏的点按手势交给 iframe,
 * 按钮收得到 pointerdown / pointerup 却收不到合成的 click(2026-10-21 探针实测);有时又照常补发 click。
 * 所以触屏抬手后等一小会儿:click 来了就由 click 触发,没来才由抬手触发,只触发一次。
 * 不在抬手当时就触发:那样面板一打开,随后补发的 click 正好落在新出现的遮罩上,又把面板关了(同日账号项目实测)。
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

/* ---------------- 子导航栏 ---------------- */

export interface SubItem { icon: IconName; label: string; run: () => void; ref?: boolean; disabled?: boolean; pcm?: string; /** 置灰时的悬停说明 */ title?: string }

/** 子导航栏:缩略预览和时间轴共用同一个组件;内容随选中对象变,换内容时滚回最左 */
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

/** 缩略卡、素材格子、卡片格子的底色:按 id 算一个固定的色相(只为相邻的分得开,不代表内容) */
export function tint(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 42% 34%)`;
}

/** 时长:00:06 / 00:06.5 */
export function fmtDur(d: number): string {
  d = Math.round(d * 10) / 10;
  const m = Math.floor(d / 60), s = d - m * 60;
  const ss = Number.isInteger(s) ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  return `${String(m).padStart(2, "0")}:${ss}`;
}

/** 时间码:00:00.0 */
export function fmtTc(t: number): string {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}
