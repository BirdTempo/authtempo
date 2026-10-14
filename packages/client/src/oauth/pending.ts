/**
 * One sign-in that waits for its redirect: its `state`, its PKCE verifier,
 * when it started, and the issuer and client that started it. RFC 9207
 * section 2.4: the client keeps the expected issuer with the state, so two
 * clients that share a store cannot take each other's sign-in.
 */
export interface PendingSignIn {
  state: string;
  verifier: string;
  issuer: string;
  clientId: string;
  /** Epoch milliseconds by the client's clock. */
  createdAt: number;
}

/**
 * Where a pending sign-in waits. `take` answers it once and removes it. `put`
 * also removes each record older than `PENDING_TTL_MS` before `p.createdAt`,
 * so an abandoned sign-in does not keep its verifier.
 */
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
      for (const [state, old] of m)
        if (p.createdAt - old.createdAt > PENDING_TTL_MS) m.delete(state);
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

/** The part of `sessionStorage` that the browser store calls. `key` and `length` serve the sweep. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const KEY_PREFIX = "authtempo-oauth:";

/** A stored record, or null when it does not parse to the full shape. */
function parsed(raw: string | null): PendingSignIn | null {
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingSignIn> | null;
    return p !== null &&
      typeof p.state === "string" &&
      typeof p.verifier === "string" &&
      typeof p.issuer === "string" &&
      typeof p.clientId === "string" &&
      typeof p.createdAt === "number"
      ? {
          state: p.state,
          verifier: p.verifier,
          issuer: p.issuer,
          clientId: p.clientId,
          createdAt: p.createdAt,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * For a single-page app: the pending sign-in survives the page load of the
 * redirect in `sessionStorage`, which the tab alone reads. A value that does
 * not parse answers null. Each start removes the records of this store that
 * are older than 10 minutes or do not parse; other keys stay.
 */
export function browserPendingStore(storage?: StorageLike): PendingStore {
  const s = (): StorageLike => {
    const found = storage ?? (globalThis as { sessionStorage?: StorageLike }).sessionStorage;
    if (!found) throw new Error("authtempo oauth: no sessionStorage in this runtime");
    return found;
  };
  return {
    put(p) {
      const st = s();
      const ours: string[] = [];
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (k?.startsWith(KEY_PREFIX)) ours.push(k);
      }
      // Collected first: a removal during the loop shifts the indexes.
      for (const k of ours) {
        const old = parsed(st.getItem(k));
        if (!old || p.createdAt - old.createdAt > PENDING_TTL_MS) st.removeItem(k);
      }
      st.setItem(`${KEY_PREFIX}${p.state}`, JSON.stringify(p));
    },
    take(state) {
      const key = `${KEY_PREFIX}${state}`;
      const raw = s().getItem(key);
      s().removeItem(key);
      return parsed(raw);
    },
  };
}
