export interface PageEnvironment {
  platform: string;
  userAgent: string;
  renderer: string;
  vendor: string;
}

export function readPageEnvironment(scope?: { navigator?: unknown; document?: unknown }): PageEnvironment;

export function pageEnvironment(): PageEnvironment;
