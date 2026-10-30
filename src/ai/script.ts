import { useSyncExternalStore } from "react";

/**
 * 剧本:用户手写的一段说明,交代这条片子要讲什么、按什么顺序讲。
 *
 * 它**每一轮都会拼进系统提示词**,而不是只在第一条消息里说一次 ——
 * 多轮跑下来模型很容易顺着中间结果越走越偏,每轮都摆在眼前才拉得住。
 * 剪辑导演写出来的编排也应该回写到这里,后面特效助理就照着它配。
 *
 * 存在 localStorage:剧本是「这台机器上这个项目在写的东西」,
 * 还没有进 .proc 项目格式(那是另一个会话在改的文件),先不动它。
 */

const KEY = "pc.ai.script";

let current = read();
const listeners = new Set<() => void>();

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function getScript(): string {
  return current;
}

export function setScript(next: string) {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* 无痕模式下存不住,内存里仍然生效 */
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useScript(): string {
  return useSyncExternalStore(subscribe, getScript, getScript);
}
