import { createSessionStore as createStore } from "@authtempo/client";
import { clientError } from "../errors.js";
import type {
  ClientSession,
  ClientUser,
  CompatClientError,
  CompatClientResult,
  SessionStore,
} from "../types.js";

/**
 * Better Auth's session atom, on the one store of `@authtempo/client` (plan
 * 11d). The store's rules live there: one read on the first subscriber, one
 * read per refetch, a stable snapshot between changes, the stale-read drop,
 * and no read from inside a notify. This file maps the compatibility result
 * to the store's `{ data, error }` and a throw to `UNEXPECTED_RESPONSE`.
 */
export function createSessionStore(
  fetchSession: () => Promise<
    CompatClientResult<{ session: ClientSession; user: ClientUser } | null>
  >,
): SessionStore & { refetchIfStarted(): void } {
  return createStore<{ session: ClientSession; user: ClientUser }, CompatClientError>({
    read: async () => {
      const r = await fetchSession();
      return r.error ? { data: null, error: r.error } : { data: r.data, error: null };
    },
    // A storage read or an app callback threw. The store shows the error and stops waiting.
    onThrow: (e) => clientError("UNEXPECTED_RESPONSE", 0, messageOfError(e)),
  });
}

const messageOfError = (e: unknown): string =>
  e instanceof Error ? e.message : "the session read failed";
