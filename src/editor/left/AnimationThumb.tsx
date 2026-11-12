import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CardDef } from "../../kernel/types";
import type { PartDef } from "../../kernel/partTypes";
import { useStore } from "../../store/project";
import { themeStyle } from "../../themes";
import { renameSnapshotIds } from "../../render/snapshotRename";
import { cyrb53 } from "../../render/cyrb53.mjs";
import { zoomFor } from "./previewZoom";
import {
  buildThumbKey,
  getCachedThumb,
  observeThumbElement,
  requestAnimationThumb,
  type AnimationThumbEntry,
} from "./animationThumbnails";

export type AnimationThumbProps =
  | { kind: "card"; def: CardDef<any> }
  | { kind: "part"; def: PartDef<any> };

/** Deterministic vector emblem used only when online isolation blocks executing a user card's JS. */
function FallbackEmblem({ id }: { id: string }) {
  const hash = parseInt(cyrb53(id).slice(0, 6), 16) || 0;
  const hueA = hash % 360;
  const hueB = (hueA + 52) % 360;
  const gradId = `pc-fb-${hash.toString(36)}`;
  return (
    <svg viewBox="0 0 160 120" className="pc-anim-thumb-fallback" aria-hidden="true">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`hsl(${hueA} 78% 58%)`} stopOpacity="0.85" />
          <stop offset="100%" stopColor={`hsl(${hueB} 82% 52%)`} stopOpacity="0.35" />
        </linearGradient>
      </defs>
      <rect x="24" y="24" width="112" height="72" rx="14" fill={`url(#${gradId})`} />
      <circle cx={56 + (hash % 24)} cy={52 + ((hash >> 4) % 16)} r="14" fill="rgba(255,255,255,0.86)" />
      <rect x="44" y="76" width="72" height="8" rx="4" fill="rgba(255,255,255,0.68)" />
    </svg>
  );
}

/**
 * Renders the deterministic representative-frame thumbnail of a card or composite part inside either
 * an overview `ThumbTile` or a detail `CardCell` / `PartCell`.
 */
export function AnimationThumb(props: AnimationThumbProps) {
  const { kind, def } = props;
  const width = useStore((s) => s.project.width);
  const height = useStore((s) => s.project.height);
  const themeId = useStore((s) => s.project.themeId);

  const key = useMemo(
    () => buildThumbKey(kind, def, width, height, themeId),
    [kind, def, width, height, themeId],
  );

  const [entry, setEntry] = useState<AnimationThumbEntry | undefined>(() => getCachedThumb(key));
  const [tileBox, setTileBox] = useState({ w: 0, h: 0 });
  const hostRef = useRef<HTMLDivElement>(null);
  const rawInstanceId = useId();

  // Synchronize immediately if key changes and the new key is already cached.
  useLayoutEffect(() => {
    setEntry(getCachedThumb(key));
  }, [key]);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const updateSize = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setTileBox((prev) =>
          Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
            ? prev
            : { w: r.width, h: r.height },
        );
      }
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cached = getCachedThumb(key);
    if (cached) {
      setEntry(cached);
      return;
    }
    const el = hostRef.current;
    if (!el) return;

    let cancelReq: (() => void) | null = null;
    const stopObs = observeThumbElement(el, (priority) => {
      if (cancelReq) return;
      cancelReq = requestAnimationThumb(
        key,
        { kind, id: def.id, width, height, themeId },
        priority,
        (ready) => {
          setEntry(ready);
        },
      );
    });

    return () => {
      stopObs();
      cancelReq?.();
    };
  }, [key, kind, def.id, width, height, themeId]);

  const renamedHtml = useMemo(() => {
    if (!entry || entry.mode !== "dom" || !entry.html) return "";
    return renameSnapshotIds(entry.html, `th_${rawInstanceId}`);
  }, [entry, rawInstanceId]);

  const stageDims = useMemo(() => ({ width, height }), [width, height]);
  const { scale, left, top } = zoomFor(entry?.box ?? null, tileBox, stageDims);

  const thumbState = !entry
    ? "pending"
    : !entry.ok || entry.unsupported
      ? "fallback"
      : entry.mode;

  return (
    <div
      ref={hostRef}
      className="pc-anim-thumb"
      data-pc-thumb={thumbState}
      data-pc-thumb-ready={entry ? "1" : "0"}
      data-pc-thumb-time={entry ? entry.t.toFixed(3) : undefined}
      data-pc-thumb-phase={entry ? entry.phase.toFixed(3) : undefined}
      data-pc-thumb-score={entry ? entry.score.toFixed(4) : undefined}
      style={themeStyle(themeId)}
    >
      {!entry ? (
        <div className="pc-anim-thumb-skeleton" aria-hidden="true" />
      ) : !entry.ok || entry.unsupported ? (
        <FallbackEmblem id={def.id} />
      ) : tileBox.w > 0 && tileBox.h > 0 ? (
        <div
          className="pc-anim-thumb-stage"
          style={{
            position: "absolute",
            left,
            top,
            width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
          }}
        >
          {entry.mode === "img" && entry.dataUrl ? (
            <img
              src={entry.dataUrl}
              alt=""
              draggable={false}
              style={{ width: "100%", height: "100%", display: "block" }}
            />
          ) : (
            <div
              className="pc-stage"
              style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}
              dangerouslySetInnerHTML={{ __html: renamedHtml }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
