import { useSyncExternalStore } from "react";
import { createAuthClient as createBaseClient } from "./client/create-auth-client.js";
import type { ClientOptions, ReactAuthClient } from "./types.js";

/** `better-auth/react`'s createAuthClient: the client with `useSession` as a hook. */
export function createAuthClient(options: ClientOptions = {}): ReactAuthClient {
  const { useSession: store, ...rest } = createBaseClient(options);
  return {
    ...rest,
    useSession() {
      const state = useSyncExternalStore(store.subscribe, store.get, store.get);
      return { ...state, refetch: store.refetch };
    },
  };
}

export type * from "./types.js";
