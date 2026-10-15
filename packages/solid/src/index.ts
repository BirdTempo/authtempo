import type { Client, ClientSessionState } from "@authtempo/client";
import {
  type Accessor,
  createComponent,
  createContext,
  createSignal,
  getOwner,
  type JSX,
  onCleanup,
  useContext,
} from "solid-js";

/**
 * The Solid binding of authtempo (plan 11d2). It puts `client.store` into a
 * Solid signal, as `@authtempo/react` does with useSyncExternalStore.
 */

const AuthContext = createContext<Client>();

/** Gives `client` to every primitive below it. Make the client once, outside the component. */
export function AuthProvider(props: { client: Client; children?: JSX.Element }): JSX.Element {
  return createComponent(AuthContext.Provider, {
    get value() {
      return props.client;
    },
    get children() {
      return props.children;
    },
  });
}

/** The client of the nearest `AuthProvider`. Throws when there is none: a fault of the app's code. */
export function useClient(): Client {
  const client = useContext(AuthContext);
  if (!client) throw new Error("authtempo solid: a primitive needs an AuthProvider above it");
  return client;
}

export interface UseSession {
  /** The state of `client.store`: `{ data, error, isPending, isRefetching }`. */
  session: Accessor<ClientSessionState>;
  refetch(): Promise<void>;
}

/**
 * The session, read at the first use and after each change. The subscription
 * ends with the owner of the component.
 */
export function useSession(): UseSession {
  const { store } = useClient();
  const [state, setState] = createSignal(store.get());
  // The setter takes a function, so the state object is never read as an updater.
  const stop = store.subscribe(() => setState(() => store.get()));
  if (getOwner()) onCleanup(stop);
  return { session: state, refetch: store.refetch };
}

/**
 * The code that `client.readRedirectError` answers. It is typed from the
 * client, so a change of the client's codes reaches this primitive with no edit here.
 */
export type AuthErrorCode = ReturnType<Client["readRedirectError"]>;

/** The error code of `?auth_error=<code>`, read once: from `url`, or from the location of the page. */
export function useAuthError(url?: string): AuthErrorCode {
  const client = useClient();
  const href = url ?? (globalThis as { location?: { href?: string } }).location?.href;
  return href ? client.readRedirectError(href) : null;
}
