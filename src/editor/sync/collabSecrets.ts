/** In-memory view of secrets protected by the local recovery vault. */
const secrets = new Map<string, unknown>();
export function cacheCollabSecrets(roomId: string, value: unknown) { if (value) secrets.set(roomId, value); else secrets.delete(roomId); }
export function cachedCollabSecrets<T>(roomId: string): T | null { return (secrets.get(roomId) as T) ?? null; }
