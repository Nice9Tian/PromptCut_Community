/** 框架的目录（仓库相对路径） */
export const REMOTION_FRAMEWORK_DIR: string;
/** 运行时那一半（仓库相对路径，不带扩展名） */
export const REMOTION_LOCK_MODULE: string;
/** 该锁的卡在转译缓存里用的键的后缀 */
export const REMOTION_LOCK_CACHE_TAG: string;
/** 一个导入的说明符指的是不是框架 */
export function isFrameworkSpecifier(spec: unknown): boolean;
/** 这份源码该不该锁、要锁哪些名字；不该锁回 null */
export function remotionLockPlan(source: string): { names: string[]; specifiers: string[] } | null;
/** 要接在这份源码末尾的那一段；不该锁回空串 */
export function remotionLockSuffix(key: string, source: string): string;
