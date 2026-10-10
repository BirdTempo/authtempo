import type {
  ClientSession,
  ClientUser,
  CompatClientResult,
  SessionState,
  SessionStore,
} from "../types.js";

/** Better Auth's session atom: one read on the first subscriber, one read per refetch, a stable snapshot between changes. */
export function createSessionStore(
  fetchSession: () => Promise<
    CompatClientResult<{ session: ClientSession; user: ClientUser } | null>
  >,
): SessionStore & { refetchIfStarted(): void } {
  let state: SessionState = { data: null, error: null, isPending: true, isRefetching: false };
  const listeners = new Set<() => void>();
  let started = false;
  let inFlight: Promise<void> | null = null;
  const set = (next: SessionState) => {
    state = next;
    for (const l of listeners) l();
  };
  const refetch = (): Promise<void> => {
    inFlight ??= (async () => {
      if (!state.isPending) set({ ...state, isRefetching: true });
      const r = await fetchSession();
      set({ data: r.error ? null : r.data, error: r.error, isPending: false, isRefetching: false });
    })().finally(() => {
      inFlight = null;
    });
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
