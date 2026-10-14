/** One sign-in that waits for its redirect: its `state`, its PKCE verifier, and when it started. */
export interface PendingSignIn {
  state: string;
  verifier: string;
  /** Epoch milliseconds by the client's clock. */
  createdAt: number;
}

/** Where a pending sign-in waits. `take` answers it once and removes it. */
export interface PendingStore {
  put(p: PendingSignIn): void | Promise<void>;
  take(state: string): PendingSignIn | null | Promise<PendingSignIn | null>;
}

/** A pending sign-in older than this is refused: the code of core lives at most 10 minutes. */
export const PENDING_TTL_MS = 600_000;

/** The pending sign-ins kept in memory at most; the oldest goes first. */
const MEMORY_MAX = 20;

/** For a CLI, a native app, or a server: the pending sign-in lives in this process. */
export function memoryPendingStore(): PendingStore {
  const m = new Map<string, PendingSignIn>();
  return {
    put(p) {
      m.set(p.state, p);
      while (m.size > MEMORY_MAX) {
        const oldest = m.keys().next().value;
        if (oldest === undefined) break;
        m.delete(oldest);
      }
    },
    take(state) {
      const p = m.get(state) ?? null;
      m.delete(state);
      return p;
    },
  };
}

/** The part of `sessionStorage` that the browser store calls. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = "authtempo-oauth:";

/**
 * For a single-page app: the pending sign-in survives the page load of the
 * redirect in `sessionStorage`, which the tab alone reads. A value that does
 * not parse answers null.
 */
export function browserPendingStore(storage?: StorageLike): PendingStore {
  const s = (): StorageLike => {
    const found = storage ?? (globalThis as { sessionStorage?: StorageLike }).sessionStorage;
    if (!found) throw new Error("authtempo oauth: no sessionStorage in this runtime");
    return found;
  };
  return {
    put(p) {
      s().setItem(`${KEY_PREFIX}${p.state}`, JSON.stringify(p));
    },
    take(state) {
      const key = `${KEY_PREFIX}${state}`;
      const raw = s().getItem(key);
      s().removeItem(key);
      if (raw === null) return null;
      try {
        const p = JSON.parse(raw) as Partial<PendingSignIn>;
        return typeof p.state === "string" &&
          typeof p.verifier === "string" &&
          typeof p.createdAt === "number"
          ? { state: p.state, verifier: p.verifier, createdAt: p.createdAt }
          : null;
      } catch {
        return null;
      }
    },
  };
}
