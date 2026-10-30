import { useCallback, useState } from "react";

/**
 * 左栏记在 localStorage 里的几样选择:当前分区(pc.left.section)、编辑分页(pc.left.editTab)、
 * 各分区打开的组(pc.left.group.<分区>)。读写都包一层 try —— 隐私模式、存储满了都不该让界面报错。
 */

export function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    if (v && allowed.includes(v)) return v;
  } catch {}
  return fallback;
}

/** 写入;传 null 就删掉这个键 */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

/**
 * 某个分区当前打开的组(null = 总览)。
 * 状态在 React 里,localStorage 只是记住它 —— 外部(比如导入完成)要打开一个组,调返回的 setter 就行,
 * 不要只写 localStorage,那样界面不会跟着变。
 */
export function useOpenGroup(section: string, allowed: readonly string[]): [string | null, (id: string | null) => void] {
  const key = `pc.left.group.${section}`;
  const [id, setId] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem(key);
      return v && allowed.includes(v) ? v : null;
    } catch {
      return null;
    }
  });
  const set = useCallback(
    (next: string | null) => {
      setId(next);
      writeStored(key, next);
    },
    [key],
  );
  return [id, set];
}
