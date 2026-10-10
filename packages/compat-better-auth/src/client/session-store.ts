import { clientError } from "../errors.js";
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
  // A read asked for while another runs. The running read may carry the state from before the
  // change that asked (a sign-out), so its answer is dropped and one newer read runs.
  let dirty = false;
  const set = (next: SessionState) => {
    state = next;
    for (const l of listeners) l();
  };
  const read = async (): ReturnType<typeof fetchSession> => {
    try {
      return await fetchSession();
    } catch (e) {
      // A storage read or an app callback threw. The store shows the error and stops waiting.
      return { data: null, error: clientError("UNEXPECTED_RESPONSE", 0, messageOfError(e)) };
    }
  };
  const refetch = (): Promise<void> => {
    if (inFlight) {
      dirty = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        do {
          dirty = false;
          if (!state.isPending) set({ ...state, isRefetching: true });
          const r = await read();
          if (dirty) continue;
          set({
            data: r.error ? null : r.data,
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

const messageOfError = (e: unknown): string =>
  e instanceof Error ? e.message : "the session read failed";
