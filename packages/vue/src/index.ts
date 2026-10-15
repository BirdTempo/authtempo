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
 * ends with the component's scope.
 */
export function useSession(): UseSession {
  const { store } = useClient();
  const state = shallowRef(store.get());
  const stop = store.subscribe(() => {
    state.value = store.get();
  });
  if (getCurrentScope()) onScopeDispose(stop);
  return { session: shallowReadonly(state), refetch: store.refetch };
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
