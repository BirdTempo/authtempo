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
  const base = {
    baseURL: options.baseURL,
    ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    // A native app has no cookie jar to trust: core reads the cookie before the bearer.
    credentials: "omit" as const,
    // No tabs and no page visibility in a native app.
    broadcast: false,
    refetchOnVisible: false,
  };
  const client = createClient({
    ...base,
    ...(options.webauthn !== undefined ? { webauthn: options.webauthn } : {}),
    token: async () => {
      try {
        return await options.store.get();
      } catch {
        return null;
      }
    },
    // Clear only the token that ended. A read can answer its 401 after a new sign-in wrote
    // another token, and that newer token must stay (plan 11d Task 12 review, J1).
    onSessionEnd: async (sent) => {
      const held = await options.store.get().catch(() => null);
      if (held === sent) await options.store.clear();
    },
  });
  // The spread keeps the inner members. An inner call that signs out would skip the token
  // clear of the signOut below; nothing in the client signs out on its own today.
  return {
    ...client,
    async signInWithBrowser() {
      let r: HandoffResult;
      try {
        r = await options.handoff.signIn();
      } catch {
        // The opener or a PKCE step threw (expoOpener passes a rejection on).
        return { ok: false, code: "unexpected", status: 0 };
      }
      if (!r.ok) return r;
      try {
        await options.store.set(r.value.token);
      } catch {
        // No holder for the new session: end it on the server, best effort, so no
        // live session is left behind (L1). Its answer does not matter.
        const token = r.value.token;
        await createClient({ ...base, token: () => token })
          .signOut()
          .catch(() => {});
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
