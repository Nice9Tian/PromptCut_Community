import { useLayoutEffect, useRef } from "react";
import { CardGpuError, CardGpuExecutor, type CardGpuValue, type ValueResolver } from "./gpuExecutor";

/** A host-owned canvas surface. The executor lives for the canvas lifetime:
 * time/source changes reuse cached programs instead of recreating WebGL state. */
export function CardSurface({ value, width, height, time, resolveSource, onReady, onError, className, enabled = true }: {
  value: CardGpuValue; width: number; height: number; time: number; resolveSource: ValueResolver;
  onReady?: (canvas: HTMLCanvasElement) => void; onError?: (error: CardGpuError) => void; className?: string; enabled?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), executor = useRef<CardGpuExecutor | null>(null);
  const resolver = useRef(resolveSource), ready = useRef(onReady), failed = useRef(onError), generation = useRef(0);
  resolver.current = resolveSource; ready.current = onReady; failed.current = onError;
  useLayoutEffect(() => { const c=canvas.current; if (!c) return;
    try { executor.current = new CardGpuExecutor(c, (source, requestedTime, signal) => resolver.current(source, requestedTime, signal)); }
    catch (error) { failed.current?.(error as CardGpuError); }
    return () => { generation.current++; executor.current?.dispose(); executor.current = null; };
  }, []);
  useLayoutEffect(() => { const c=canvas.current, e=executor.current; if(!c||!e||!enabled)return; c.width=width;c.height=height; const abort=new AbortController(), ticket=++generation.current;
    void e.execute(value,time,abort.signal).then(()=>{if(!abort.signal.aborted && ticket===generation.current)ready.current?.(c);}).catch(error=>{if(!abort.signal.aborted && ticket===generation.current)failed.current?.(error as CardGpuError);}); return()=>{ generation.current++; abort.abort(); }; },[value,width,height,time,enabled,resolveSource]);
  return <canvas ref={canvas} className={className} width={width} height={height} style={{ display: "block", width: "100%", height: "100%" }} />;
}
