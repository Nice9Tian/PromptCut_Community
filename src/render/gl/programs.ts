/**
 * canvas 卡函数那一半的注册表(R9 M1)。
 *
 * 每张迁进共享渲染器的卡在自己文件旁边放一个 `<id>.gl.ts`,导出 `program`(`CanvasCardProgram`)。
 * 这里用 `import.meta.glob` 一次收齐:**Worker 和主线程退路 import 的是同一张表**,
 * 所以两条路画出来的是同一份代码。`eager: true` —— Worker 里不做代码分割,一个 bundle 带齐。
 *
 * 键 = 文件名去掉 `.gl.ts`(和卡 id 一致);`.gl.ts` 里也可以显式导出 `programId` 覆盖。
 * 用户卡的 `.gl.ts` 在桌面运行环境里由 vite 照常服务;在线浏览器模式只有内置卡。
 */
import type { CanvasCardProgram } from "./CanvasCardProgram";

const modules = import.meta.glob<{ program?: CanvasCardProgram; programId?: string }>("../../cards/**/*.gl.ts", { eager: true });

const table = new Map<string, CanvasCardProgram>();
for (const [file, mod] of Object.entries(modules)) {
  if (!mod?.program) continue;
  const base = file.split("/").pop()!.replace(/\.gl\.ts$/, "");
  table.set(mod.programId ?? base, mod.program);
}

export function programOf(programId: string): CanvasCardProgram | undefined {
  return table.get(programId);
}

export function programIds(): string[] {
  return [...table.keys()].sort();
}
