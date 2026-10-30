export const MEDIA_COOKIE: string;
export const MEDIA_COOKIE_MAX_AGE_S: number;
export const MEDIA_S_PREFIX: string;
export const SID_PATTERN: string;
export const MEDIA_S_PATH_PATTERN: string;
export const TICKET_PATTERN: string;
export const ASSET_API_PREFIX: string;
export const MEDIA_PROXY_BASE: string;
export const STAGE_CSP_META: string;
export const STAGE_CSP_HEADER_ONLY_DIRECTIVE: string;
export function stageCspHeader(editorOrigin: string, opts?: { template?: boolean }): string;
export function editorCspHeader(stageOrigins: readonly string[], opts?: { template?: boolean }): string;
export function stageSecurityHeaders(editorOrigin: string, opts?: { template?: boolean }): Record<string, string>;
export function editorSecurityHeaders(stageOrigins: readonly string[], opts?: { template?: boolean }): Record<string, string>;
export function isSid(v: unknown): v is string;
export function isTicketShaped(v: unknown): v is string;
export function mediaGrantUrl(stageOrigin: string, sid: string): string;
export function mediaSBase(sid: string): string;
export function mediaGrantCookie(sid: string, ticket: string, opts?: { secure?: boolean }): string;
export function mediaGrantCorsHeaders(editorOrigin: string): Record<string, string>;
export type MediaSRoute =
  | { kind: "none" }
  | { kind: "reject"; status: number }
  | { kind: "preflight"; headers: Record<string, string> }
  | { kind: "grant"; headers: Record<string, string> }
  | { kind: "proxy"; path: string; authorization: string };
export function mediaSRoute(
  req: { method?: string; pathname: string; origin?: string | null; authorization?: string | null; cookie?: string | null },
  opts: { editorOrigin: string; secure?: boolean },
): MediaSRoute;
export function cookieValue(header: string | null | undefined, name: string): string | null;
