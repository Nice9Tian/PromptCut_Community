/** Framework directory (repository-relative path) */
export const REMOTION_FRAMEWORK_DIR: string;
/** Runtime counterpart (repository-relative path, without extension) */
export const REMOTION_LOCK_MODULE: string;
/** Suffix for keys used in transpilation cache by cards with this lock */
export const REMOTION_LOCK_CACHE_TAG: string;
/** Whether an import specifier refers to the framework */
export function isFrameworkSpecifier(spec: unknown): boolean;
/** Whether this source code should be locked and which names to lock; returns null if it should not be locked */
export function remotionLockPlan(source: string): { names: string[]; specifiers: string[] } | null;
/** The snippet to append to the end of this source code; returns an empty string if it should not be locked */
export function remotionLockSuffix(key: string, source: string): string;
