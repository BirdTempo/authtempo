import {
  type BrowserWebAuthn,
  type Client,
  type ClientResult,
  createClient,
} from "@authtempo/client";
import type { Handoff, HandoffResult } from "./handoff.js";
import type { TokenStore } from "./token-store.js";

export interface NativeClientOptions {
  baseURL: string;
  basePath?: string | undefined;
  /** The handoff of this app: `createHandoff({ baseURL, redirect, opener })`. */
  handoff: Handoff;
  /** Where the bearer token lives: `expoTokenStore(SecureStore)` or Electron's `createTokenStore`. */
  store: TokenStore;
  fetch?: typeof fetch | undefined;
  webauthn?: BrowserWebAuthn | undefined;
}

export interface NativeClient extends Client {
  /** The system browser sign-in: the handoff, then the token in the store, then the session store's read. */
  signInWithBrowser(): Promise<HandoffResult>;
}

/**
 * The client of a native or desktop app in one call (plan 11d, spec 20). It
 * sends the stored token as the bearer and no cookie, clears the token when
 * `session()` answers null, and clears it at the sign-out. Nothing throws for
 * an answer: a store that throws turns into `unexpected`.
 */
export function createNativeClient(options: NativeClientOptions): NativeClient {
  const client = createClient({
    baseURL: options.baseURL,
    ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.webauthn !== undefined ? { webauthn: options.webauthn } : {}),
    // A native app has no cookie jar to trust: core reads the cookie before the bearer.
    credentials: "omit",
    token: async () => {
      try {
        return await options.store.get();
      } catch {
        return null;
      }
    },
    onSessionEnd: () => options.store.clear(),
    // No tabs and no page visibility in a native app.
    broadcast: false,
    refetchOnVisible: false,
  });
  return {
    ...client,
    async signInWithBrowser() {
      const r = await options.handoff.signIn();
      if (!r.ok) return r;
      try {
        await options.store.set(r.value.token);
      } catch {
        return { ok: false, code: "unexpected", status: 0 };
      }
      client.store.refetchIfStarted();
      return r;
    },
    async signOut(): Promise<ClientResult<{ ok: true }>> {
      const r = await client.signOut();
      // A server that ended or never knew the session: the token is dead either way.
      if (r.ok || r.code === "unauthorized") await options.store.clear().catch(() => {});
      return r;
    },
  };
}
