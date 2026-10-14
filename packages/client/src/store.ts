/**
 * The session store (plan 11d, spec 20), moved from the compatibility
 * package so that an app on authtempo's own client has it. One read at the
 * first subscriber, one read per refetch, and a stable snapshot between
 * changes. The state is Better Auth's `useSession` shape (`isPending`,
 * `isRefetching`), so the compatibility package and the bindings map it 1:1.
 */

/** The name of the `BroadcastChannel` that tells the other tabs of an origin about a change. */
export const SESSION_CHANNEL = "authtempo-session";

export interface SessionState<D, E> {
  data: D | null;
  error: E | null;
  /** True until the first read ends. */
  isPending: boolean;
  /** True while a read after the first one runs. */
  isRefetching: boolean;
}

export interface SessionStore<D, E> {
  /** The current state. The same object until the next change, as `useSyncExternalStore` needs. */
  get(): SessionState<D, E>;
  /** The first subscriber starts the first read. Answers the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Reads the session again. A call while a read runs queues one more read and drops the running one's answer. */
  refetch(): Promise<void>;
  /** Reads again when a listener ever subscribed, else nothing. The trigger of a change and of another tab's message. */
  refetchIfStarted(): void;
}

export function createSessionStore<D, E>(input: {
  /**
   * One read of the session. Answer `error: null` for a success: the store
   * tests `error !== null`, so an `undefined` error shows as a failure with
   * `data` null.
   */
  read(): Promise<{ data: D | null; error: E | null }>;
  /** The error state of a read that threw: a storage read or an app callback. */
  onThrow(e: unknown): E;
}): SessionStore<D, E> {
  let state: SessionState<D, E> = {
    data: null,
    error: null,
    isPending: true,
    isRefetching: false,
  };
  const listeners = new Set<() => void>();
  let started = false;
  let inFlight: Promise<void> | null = null;
  // A read asked for while another runs. The running read may carry the state from before the
  // change that asked (a sign-out), so its answer is dropped and one newer read runs.
  let dirty = false;
  // Set while the listeners run. A listener that refetches on every notify calls `refetch` from
  // inside `set`; the state it sees is the newest, so the call starts no read and queues none.
  // Without this guard each read's own notify asked for the next read, with no end (plan 9
  // N-R7, plan 9b2). A call from outside a notify during a read still queues one more read.
  let notifying = 0;
  const set = (next: SessionState<D, E>) => {
    state = next;
    notifying++;
    try {
      for (const l of listeners) {
        try {
          l();
        } catch (e) {
          // One listener's throw must not stop the later ones; report it apart, as an event handler's would be.
          queueMicrotask(() => {
            throw e;
          });
        }
      }
    } finally {
      notifying--;
    }
  };
  const read = async (): Promise<{ data: D | null; error: E | null }> => {
    try {
      return await input.read();
    } catch (e) {
      // The store shows the error and stops waiting.
      return { data: null, error: input.onThrow(e) };
    }
  };
  const refetch = (): Promise<void> => {
    if (notifying > 0) return inFlight ?? Promise.resolve();
    if (inFlight) {
      dirty = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        do {
          dirty = false;
          // After a dropped read the state already shows the refetch: no second notify.
          if (!state.isPending && !state.isRefetching) set({ ...state, isRefetching: true });
          const r = await read();
          if (dirty) continue;
          set({
            data: r.error !== null ? null : r.data,
            error: r.error,
            isPending: false,
            isRefetching: false,
          });
        } while (dirty);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (!started) {
        started = true;
        void refetch();
      }
      return () => {
        listeners.delete(listener);
      };
    },
    refetch,
    refetchIfStarted() {
      if (started) void refetch();
    },
  };
}
