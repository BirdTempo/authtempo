import type { Client, ClientSessionState } from "@authtempo/client";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * The React binding of authtempo (plan 11d, spec 20). It adds what the plain
 * client cannot: a context for the client, `useSession` over `client.store`,
 * and `useAuthError`. It uses no DOM API, so it runs in React DOM and React Native.
 */

const AuthContext = createContext<Client | null>(null);

/** Gives `client` to every hook below it. Make the client once, outside the render. */
export function AuthProvider(props: { client: Client; children?: ReactNode }): ReactNode {
  return createElement(AuthContext.Provider, { value: props.client }, props.children);
}

/** The client of the nearest `AuthProvider`. Throws when there is none: a fault of the app's code. */
export function useClient(): Client {
  const client = useContext(AuthContext);
  if (!client) throw new Error("authtempo react: a hook needs an AuthProvider above it");
  return client;
}

/** The session state of `client.store`, and its `refetch`. Better Auth's `useSession` shape. */
export type UseSession = ClientSessionState & { refetch(): Promise<void> };

/**
 * The session, read at the first mount and after each change (`client.store`).
 * A server render shows the pending state: the store reads at its first
 * subscriber, and a server render never subscribes.
 */
export function useSession(): UseSession {
  const { store } = useClient();
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return useMemo(() => ({ ...state, refetch: store.refetch }), [state, store]);
}

/**
 * The code that `client.readRedirectError` answers. It is typed from the
 * client, so a change of the client's codes reaches this hook with no edit here.
 */
export type AuthErrorCode = ReturnType<Client["readRedirectError"]>;

/**
 * The error code of `?auth_error=<code>`, read once at mount: from `url`, or
 * from the location of the page. Null when the URL has none, or when the
 * runtime has no location (React Native) and no `url` is given.
 */
export function useAuthError(url?: string): AuthErrorCode {
  const client = useClient();
  const [code] = useState(() => {
    const href = url ?? (globalThis as { location?: { href?: string } }).location?.href;
    return href ? client.readRedirectError(href) : null;
  });
  return code;
}
