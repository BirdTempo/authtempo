import type { PublicSession } from "@tempo-auth/core";
import { ERRORS } from "@tempo-auth/core/errors";
import { type ClientResult, ok } from "./result.js";
import { createTransport, type TransportOptions } from "./transport.js";

export interface ClientOptions extends TransportOptions {}

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
  errors: typeof ERRORS;
}

export function createClient(options: ClientOptions): Client {
  const call = createTransport(options);
  return {
    async session() {
      const r = await call<PublicSession>("GET", "/session");
      if (!r.ok && r.code === "unauthorized") return ok(null);
      return r;
    },
    signOut: () => call<{ ok: true }>("POST", "/sign-out", {}),
    magicLink: {
      request: (input) => call<{ sent: true }>("POST", "/magic-link/request", input),
      verify: (input) => call<PublicSession>("POST", "/magic-link/verify", input),
    },
    handoff: {
      redeem: (input) => call<{ token: string } & PublicSession>("POST", "/handoff/redeem", input),
    },
    errors: ERRORS,
  };
}
