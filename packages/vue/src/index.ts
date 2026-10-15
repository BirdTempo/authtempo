import type { Client, ClientSessionState } from "@authtempo/client";
import {
  getCurrentScope,
  type InjectionKey,
  inject,
  onScopeDispose,
  type Plugin,
  type ShallowRef,
  shallowReadonly,
  shallowRef,
} from "vue";

/**
 * The Vue binding of authtempo (plan 11d2). It puts `client.store` into Vue's
 * reactivity, as `@authtempo/react` does with useSyncExternalStore. The server
 * of Nuxt is in `@authtempo/vue/nuxt`.
 */

const CLIENT: InjectionKey<Client> = Symbol("authtempo-client");

/** Gives `client` to every composable of the app: `app.use(authPlugin(client))`. */
export function authPlugin(client: Client): Plugin {
  return {
    install(app) {
      app.provide(CLIENT, client);
    },
  };
}

/** The client of `authPlugin`. Throws when the plugin is not installed: a fault of the app's code. */
export function useClient(): Client {
  const client = inject(CLIENT, null);
  if (!client) throw new Error("authtempo vue: a composable needs app.use(authPlugin(client))");
  return client;
}

export interface UseSession {
  /** The state of `client.store`: `{ data, error, isPending, isRefetching }`. */
  session: Readonly<ShallowRef<ClientSessionState>>;
  refetch(): Promise<void>;
}

/**
 * The session, read at the first use and after each change. The store answers
 * the same object until a change, so a shallow ref is enough. The subscription
 * ends with the component's scope. A server render never subscribes, as in
 * `@authtempo/react`: it shows the store's current state (pending before the
 * first read) and starts no read.
 */
export function useSession(): UseSession {
  const { store } = useClient();
  const state = shallowRef(store.get());
  const result = { session: shallowReadonly(state), refetch: store.refetch };
  // A server render (no window) runs no onScopeDispose, so a subscription there
  // would stay, and its read would run with no cookie of the person. Vue's
  // import.meta.env.SSR is a value of the app's build, not of this library.
  if (typeof window === "undefined") return result;
  const stop = store.subscribe(() => {
    state.value = store.get();
  });
  if (getCurrentScope()) onScopeDispose(stop);
  return result;
}

/**
 * The code that `client.readRedirectError` answers. It is typed from the
 * client, so a change of the client's codes reaches this composable with no edit here.
 */
export type AuthErrorCode = ReturnType<Client["readRedirectError"]>;

/** The error code of `?auth_error=<code>`, read once: from `url`, or from the location of the page. */
export function useAuthError(url?: string): AuthErrorCode {
  const client = useClient();
  const href = url ?? (globalThis as { location?: { href?: string } }).location?.href;
  return href ? client.readRedirectError(href) : null;
}
