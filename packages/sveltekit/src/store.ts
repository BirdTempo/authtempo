import type { Client, ClientSessionState } from "@authtempo/client";

/**
 * The Svelte store of the session (plan 11d2). It fits the store contract of
 * Svelte with no import of Svelte: `subscribe(run)` calls `run` at once and
 * answers the unsubscribe. In a component: `$session.data`.
 */

/** The store contract of svelte/store. */
export interface Readable<T> {
  subscribe(run: (value: T) => void): () => void;
}

export interface SessionReadable extends Readable<ClientSessionState> {
  refetch(): Promise<void>;
}

/**
 * `client.store` as a Svelte store. Make it once per client. `client.store`
 * answers the same object until a change, so `run` gets a new value only at a
 * change. A server render never subscribes to the client store, as in
 * `@authtempo/react`: a `$session` of a server render gets the store's current
 * state (pending before the first read), and starts no read. A read there has
 * no cookie of the person, and a later render would show its answer to every person.
 */
export function sessionStore(client: Client): SessionReadable {
  const { store } = client;
  return {
    subscribe(run) {
      run(store.get());
      // The check runs at each subscribe, not at the import: no window is a server render.
      if (typeof window === "undefined") return () => {};
      return store.subscribe(() => run(store.get()));
    },
    refetch: store.refetch,
  };
}

/**
 * The code that `client.readRedirectError` answers. It is typed from the
 * client, so a change of the client's codes reaches this entry with no edit here.
 */
export type AuthErrorCode = ReturnType<Client["readRedirectError"]>;

/** The error code of `?auth_error=<code>` in `url`, or in the location of the page. */
export function authError(client: Client, url?: string): AuthErrorCode {
  const href = url ?? (globalThis as { location?: { href?: string } }).location?.href;
  return href ? client.readRedirectError(href) : null;
}
