/**
 * The type shell, inside the page, of the shared project client (`server/auth/client.mjs`, `route.mjs`,
 * `hosted-default.mjs`, `product.mjs`).
 *
 * These .mjs files work in both the browser and Node and import no Node modules (contract
 * `docs/plan/auth-contract.md` section 11, `docs/plan/shared-project-contract.md` section 3), and the
 * page imports them directly; they have no .d.ts, so the shapes are declared here in place.
 */
// @ts-expect-error .mjs without type declarations
import * as clientMod from "../../../server/auth/client.mjs";
// @ts-expect-error .mjs without type declarations
import * as routeMod from "../../../server/auth/route.mjs";
// @ts-expect-error .mjs without type declarations
import * as hostedMod from "../../../server/auth/hosted-default.mjs";
// @ts-expect-error .mjs without type declarations
import { PRODUCT } from "../../../server/auth/product.mjs";

export type SharedMode = "free" | "restricted";
export type Where = "lan" | "hosted";

export interface Kdf {
  alg: string;
  iter: number;
}

export interface Candidate {
  /** Trusted service identity used for device-owned recovery. */
  service?: string;
  access?: string;
  routeProtocol?: string;
  originalHost?: boolean;
  where: Where;
  /** The http address of the document service, ending with `/` (ruled in contract section 11) */
  base: string;
  projectId: string;
  name: string;
  mode: SharedMode;
  hostDeviceName?: string;
  via?: "discover" | "manual";
  /** The address of the host's asset service in a LAN discovery announcement (brought over by `route.mjs`; used as a fallback asset service for local projects, `assetTiers.lanAssetBaseOf`) */
  asset?: string;
  /**
   * WebSocket address (C10a): candidates whose credential source goes through `/hosted/` (online page,
   * pasted invite link) carry it, keeping the trailing slash (`hostedWsUrlOf` in `src/online/invite.ts`);
   * if absent, falls back to `route.wsBaseOf(base)`.
   */
  ws?: string;
}

export interface FindResult {
  candidates: Candidate[];
  errors: { where: Where; reason: string; status?: number; message?: string }[];
}

export type Route =
  | { action: "enter"; candidate: Candidate }
  | { action: "choose"; candidates: Candidate[] }
  | { action: "not-found"; errors: FindResult["errors"] };

export interface LanHost {
  projectId: string;
  name: string;
  mode: SharedMode;
  hostDeviceName?: string;
  docservice: string;
  asset?: string;
}

interface ClientApi {
  KDF_DEFAULT: Kdf;
  deriveKey(password: string, salt: string, kdf?: Kdf): Promise<string>;
  makeCredential(password: string, kdf?: Kdf): Promise<{ salt: string; key: string }>;
  adminProof(o: { key: string; projectId: string; username: string; op: string; nonce: string }): Promise<string>;
  buildAuthProtocols(o: {
    base: string;
    projectId: string;
    username: string;
    deviceId: string;
    deviceName: string;
    as?: "member" | "creator";
    password?: string;
    key?: string;
    role?: "page" | "agent" | "render";
    onKey?: (key: string) => void;
    fetch?: typeof globalThis.fetch;
  }): Promise<string[]>;
  lookupProject(o: { base: string; name: string }): Promise<{ projectId: string; name: string; mode: SharedMode }>;
  /** C10a: looks up the project by invite code (does not consume an attempt) */
  resolveInvite(o: { base: string; code: string }): Promise<{ projectId: string; name: string; mode: SharedMode }>;
  /** C10a: redeems by invite code; for open entry, the project passphrase's K is also returned */
  redeemInvite(o: { base: string; code: string; username: string; deviceId: string }): Promise<{ projectId: string; name: string; mode: SharedMode; kdf?: Kdf; key?: string }>;
  /** [ruling] `shared/verify`: whether the server accepts this proof (401 returns false, other errors throw) */
  verifyProtocols(o: { base: string; protocols: string[]; fetch?: typeof globalThis.fetch }): Promise<boolean>;
}

interface RouteApi {
  wsBaseOf(url: string): string;
  candidateBaseOf(url: string): string;
  findSharedProject(o: {
    name: string;
    hostedUrl?: string | null | false;
    uiHostedUrl?: string | null;
    lan?: { discover?: (o: { name: string; timeoutMs: number }) => Promise<{ hosts: LanHost[]; errors?: { reason: string }[] }>; manual?: string[]; timeoutMs?: number };
  }): Promise<FindResult>;
  pickRoute(r: FindResult): Route;
  createSharedProject(o: {
    where: Where;
    name: string;
    mode: SharedMode;
    creator: { username: string; password: string };
    password?: string;
    list?: { username: string; password: string }[];
    uiHostedUrl?: string | null;
    hostedUrl?: string;
  }): Promise<{ where: Where; base: string; projectId: string; name: string; mode: SharedMode }>;
}

interface HostedApi {
  DEFAULT_HOSTED_URL: string;
  resolveHostedUrl(o?: { ui?: string | null }): string;
  migrateHostedText(text: string): string;
  migrateHostedDeep<T>(value: T): T;
}

export const client = clientMod as ClientApi;
export const route = routeMod as RouteApi;
export const hosted = hostedMod as HostedApi;

/** Where the collaboration panel of this version can put a project, set by the product declaration (`product.config.json`): the public edition only has LAN, the closed-source edition adds the cloud */
export const collabTargets = (PRODUCT as { collab: { targets: Where[] } }).collab.targets;
export const hostedTarget = collabTargets.includes("hosted");

/** Error returned by a shared endpoint (`callJson` in `client.mjs`): carries the HTTP status and a reason word, and 429 also carries the cooldown seconds (C10a) */
export function errorStatus(e: unknown): { status: number | null; reason: string | null; retryAfter: number | null } {
  const err = e as { status?: unknown; reason?: unknown; retryAfter?: unknown };
  return {
    status: typeof err?.status === "number" ? err.status : null,
    reason: typeof err?.reason === "string" ? err.reason : null,
    retryAfter: typeof err?.retryAfter === "number" && err.retryAfter > 0 ? err.retryAfter : null,
  };
}
