import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The brief notice at the bottom of a section ("Added 0.5s crossfade", "Select a clip on the
 * timeline first" and the like).
 * Mounted at the section level and always rendered: whether the user is on the overview, a group's
 * detail or search results, the notice is visible.
 * A new notice replaces the old one, and the timer restarts.
 */
export function useFlash(): [string | null, (text: string, ms?: number) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const flash = useCallback((text: string, ms = 2600) => {
    if (timer.current) window.clearTimeout(timer.current);
    setMsg(text);
    timer.current = window.setTimeout(() => {
      setMsg(null);
      timer.current = null;
    }, ms);
  }, []);

  return [msg, flash];
}

export function FlashBar({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div className="pc-left-flash" role="status" data-pc="left-flash">
      {msg}
    </div>
  );
}
