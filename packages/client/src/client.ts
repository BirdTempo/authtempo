import type {
  PasskeySummary,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  PublicSession,
} from "@tempo-auth/core";
import { ERRORS } from "@tempo-auth/core/errors";
import { type ClientResult, fail, ok } from "./result.js";
import { createTransport, type TransportOptions } from "./transport.js";
import { type BrowserWebAuthn, browserWebAuthn, WebAuthnCancelled } from "./webauthn.js";

export type PasskeySummaryJSON = Omit<PasskeySummary, "createdAt"> & { createdAt: string };

export interface ClientOptions extends TransportOptions {
  /** The browser WebAuthn seam. Default `browserWebAuthn()`. Tests inject a soft one. */
  webauthn?: BrowserWebAuthn;
}

export interface Client {
  /** The caller's session, or null when the API answers 401. A null is a normal state, not a failure. */
  session(): Promise<ClientResult<PublicSession | null>>;
  signOut(): Promise<ClientResult<{ ok: true }>>;
  magicLink: {
    request(input: { email: string; next?: string }): Promise<ClientResult<{ sent: true }>>;
    /** The JSON verify: the session answer with the cookie. A form post is the page's job, not the client's. */
    verify(input: { token: string }): Promise<ClientResult<PublicSession>>;
  };
  handoff: {
    redeem(input: {
      code: string;
      verifier: string;
    }): Promise<ClientResult<{ token: string } & PublicSession>>;
  };
  passkey: {
    /** Needs a session. Registers a new passkey for the signed-in user. */
    register(input?: { name?: string }): Promise<ClientResult<PasskeySummaryJSON>>;
    /** A discoverable-credential sign-in. Answers the session; the browser gets the cookie. */
    signIn(): Promise<ClientResult<PublicSession>>;
  };
  passkeys: {
    list(): Promise<ClientResult<PasskeySummaryJSON[]>>;
    delete(input: { id: string }): Promise<ClientResult<{ ok: true }>>;
  };
  errors: typeof ERRORS;
}

export function createClient(options: ClientOptions): Client {
  const call = createTransport(options);
  const webauthn = options.webauthn ?? browserWebAuthn();
  /** Runs one ceremony; a dismissed prompt is `cancelled`, any other throw is `unexpected`. */
  async function ceremony<T>(run: () => Promise<T>): Promise<ClientResult<T>> {
    try {
      return ok(await run());
    } catch (e) {
      return fail(e instanceof WebAuthnCancelled ? "cancelled" : "unexpected", 0);
    }
  }
  return {
    async session() {
      const r = await call<PublicSession>("GET", "/session");
      if (!r.ok && r.code === "unauthorized") return ok(null);
      return r;
    },
    // The empty object makes the content type JSON and the body harmless to read; the router's POST Origin rule still applies.
    signOut: () => call<{ ok: true }>("POST", "/sign-out", {}),
    magicLink: {
      request: (input) => call<{ sent: true }>("POST", "/magic-link/request", input),
      verify: (input) => call<PublicSession>("POST", "/magic-link/verify", input),
    },
    handoff: {
      redeem: (input) => call<{ token: string } & PublicSession>("POST", "/handoff/redeem", input),
    },
    passkey: {
      async register(input = {}) {
        const options = await call<PublicKeyCredentialCreationOptionsJSON>(
          "POST",
          "/passkey/register/options",
          {},
        );
        if (!options.ok) return options;
        const response = await ceremony(() => webauthn.create(options.value));
        if (!response.ok) return response;
        const r = await call<{ passkey: PasskeySummaryJSON }>("POST", "/passkey/register/verify", {
          response: response.value,
          ...(input.name !== undefined ? { name: input.name } : {}),
        });
        return r.ok ? ok(r.value.passkey) : r;
      },
      async signIn() {
        const options = await call<PublicKeyCredentialRequestOptionsJSON>(
          "POST",
          "/passkey/authenticate/options",
          {},
        );
        if (!options.ok) return options;
        const response = await ceremony(() => webauthn.get(options.value));
        if (!response.ok) return response;
        return call<PublicSession>("POST", "/passkey/authenticate/verify", {
          response: response.value,
        });
      },
    },
    passkeys: {
      async list() {
        const r = await call<{ passkeys: PasskeySummaryJSON[] }>("GET", "/passkeys");
        return r.ok ? ok(r.value.passkeys) : r;
      },
      delete: (input) => call<{ ok: true }>("POST", "/passkeys/delete", input),
    },
    errors: ERRORS,
  };
}
