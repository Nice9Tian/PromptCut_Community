import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 分区底部那条一闪而过的提示(「已加 0.5s 交叉溶解」「先在时间轴上选中一个片段」之类)。
 * 挂在分区这一级、常驻渲染:不管用户停在总览、组详情还是搜索结果里,提示都看得见。
 * 新提示顶掉旧的,计时从头算。
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
