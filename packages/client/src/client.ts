import type {
  ApiTokenSummary,
  InvitationSummary,
  MemberSummary,
  OrganizationSummary,
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

export type OrganizationJSON = Omit<OrganizationSummary, "createdAt"> & { createdAt: string };
export type MemberJSON = Omit<MemberSummary, "createdAt"> & { createdAt: string };
export type InvitationJSON = Omit<InvitationSummary, "expiresAt" | "createdAt"> & {
  expiresAt: string;
  createdAt: string;
};
export type ApiTokenSummaryJSON = Omit<
  ApiTokenSummary,
  "expiresAt" | "lastUsedAt" | "createdAt"
> & {
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export interface ClientOptions extends TransportOptions {
  /** The browser WebAuthn seam. Default `browserWebAuthn()`. Tests inject a soft one. */
  webauthn?: BrowserWebAuthn | undefined;
}

export interface Client {
  /** The caller's session, or null when the API answers 401. A null is a normal state, not a failure. */
  session(): Promise<ClientResult<PublicSession | null>>;
  signOut(): Promise<ClientResult<{ ok: true }>>;
  magicLink: {
    request(input: {
      email: string;
      next?: string | undefined;
    }): Promise<ClientResult<{ sent: true }>>;
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
    register(input?: { name?: string | undefined }): Promise<ClientResult<PasskeySummaryJSON>>;
    /** A discoverable-credential sign-in. Answers the session; the browser gets the cookie. */
    signIn(): Promise<ClientResult<PublicSession>>;
  };
  passkeys: {
    list(): Promise<ClientResult<PasskeySummaryJSON[]>>;
    delete(input: { id: string }): Promise<ClientResult<{ ok: true }>>;
  };
  /**
   * Every operation answers `not_found` when the server runs without the `password` config.
   * `signUp`, `signIn`, and `reset` answer the bearer token. A browser app keeps the cookie, and a native app stores the token.
   */
  password: {
    signUp(input: {
      email: string;
      password: string;
      name?: string | undefined;
    }): Promise<ClientResult<{ token: string } & PublicSession>>;
    signIn(input: {
      email: string;
      password: string;
    }): Promise<ClientResult<{ token: string } & PublicSession>>;
    /** A new verify link. Always `{ sent: true }`, except `rate_limited`, so it does not tell whether the address has an account. */
    resendVerification(input: { email: string }): Promise<ClientResult<{ sent: true }>>;
    /** The JSON verify of the link's token. Sets the session cookie when the address was unverified. */
    verifyEmail(input: { token: string }): Promise<ClientResult<{ verified: true }>>;
    requestReset(input: {
      email: string;
      next?: string | undefined;
    }): Promise<ClientResult<{ sent: true }>>;
    reset(input: {
      token: string;
      password: string;
    }): Promise<ClientResult<{ token: string } & PublicSession>>;
    change(input: {
      currentPassword?: string | undefined;
      newPassword: string;
    }): Promise<ClientResult<{ ok: true }>>;
  };
  /** Every operation answers `not_found` when the server runs without the `organizations` config. */
  organizations: {
    create(input: {
      slug: string;
      name: string;
      metadata?: Record<string, unknown> | null | undefined;
    }): Promise<ClientResult<{ organization: OrganizationJSON; member: MemberJSON }>>;
    list(): Promise<ClientResult<{ organization: OrganizationJSON; role: string }[]>>;
    update(input: {
      organizationId: string;
      name?: string | undefined;
      slug?: string | undefined;
      metadata?: Record<string, unknown> | null | undefined;
    }): Promise<ClientResult<OrganizationJSON>>;
    delete(input: { organizationId: string }): Promise<ClientResult<{ ok: true }>>;
    members: {
      list(input: { organizationId: string }): Promise<ClientResult<MemberJSON[]>>;
      add(input: {
        organizationId: string;
        userId: string;
        role: string;
      }): Promise<ClientResult<MemberJSON>>;
      role(input: {
        organizationId: string;
        userId: string;
        role: string;
      }): Promise<ClientResult<MemberJSON>>;
      remove(input: {
        organizationId: string;
        userId: string;
      }): Promise<ClientResult<{ ok: true }>>;
    };
    invitations: {
      /** The invitation is mailed. The token never comes back to the inviter. */
      invite(input: {
        organizationId: string;
        email: string;
        role: string;
      }): Promise<ClientResult<InvitationJSON>>;
      list(input: { organizationId: string }): Promise<ClientResult<InvitationJSON[]>>;
      revoke(input: {
        organizationId: string;
        invitationId: string;
      }): Promise<ClientResult<{ ok: true }>>;
      accept(input: {
        token: string;
      }): Promise<ClientResult<{ organization: OrganizationJSON; member: MemberJSON }>>;
      decline(input: { token: string }): Promise<ClientResult<{ ok: true }>>;
    };
    /** Answers the session, so the caller reads `session.activeOrganizationId` from it. `null` clears it. */
    setActive(input: { organizationId: string | null }): Promise<ClientResult<PublicSession>>;
  };
  /**
   * API tokens for scripts and CLIs. `create`, `list`, and `revoke` need a
   * session: a token answers `unauthorized` there. `current` needs a token:
   * a CLI passes `token: () => "tk_…"` to `createClient`.
   */
  tokens: {
    create(input: {
      name: string;
      expiresInDays?: number | null | undefined;
      organizationId?: string | undefined;
    }): Promise<ClientResult<{ token: string; apiToken: ApiTokenSummaryJSON }>>;
    list(): Promise<ClientResult<ApiTokenSummaryJSON[]>>;
    revoke(input: { id: string }): Promise<ClientResult<{ ok: true }>>;
    current(): Promise<
      ClientResult<{ user: PublicSession["user"]; apiToken: ApiTokenSummaryJSON }>
    >;
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
    password: {
      signUp: ({ name, ...rest }) =>
        call<{ token: string } & PublicSession>("POST", "/password/sign-up", {
          ...rest,
          ...(name !== undefined ? { name } : {}),
        }),
      signIn: (input) =>
        call<{ token: string } & PublicSession>("POST", "/password/sign-in", input),
      resendVerification: (input) => call<{ sent: true }>("POST", "/password/verify/resend", input),
      verifyEmail: (input) => call<{ verified: true }>("POST", "/password/verify", input),
      requestReset: ({ next, ...rest }) =>
        call<{ sent: true }>("POST", "/password/reset/request", {
          ...rest,
          ...(next !== undefined ? { next } : {}),
        }),
      reset: (input) => call<{ token: string } & PublicSession>("POST", "/password/reset", input),
      change: ({ currentPassword, newPassword }) =>
        call<{ ok: true }>("POST", "/password/change", {
          ...(currentPassword !== undefined ? { currentPassword } : {}),
          newPassword,
        }),
    },
    organizations: {
      create: ({ metadata, ...rest }) =>
        call<{ organization: OrganizationJSON; member: MemberJSON }>(
          "POST",
          "/organizations/create",
          { ...rest, ...(metadata !== undefined ? { metadata } : {}) },
        ),
      async list() {
        const r = await call<{
          organizations: { organization: OrganizationJSON; role: string }[];
        }>("GET", "/organizations");
        return r.ok ? ok(r.value.organizations) : r;
      },
      async update({ metadata, name, slug, organizationId }) {
        const r = await call<{ organization: OrganizationJSON }>("POST", "/organizations/update", {
          organizationId,
          ...(name !== undefined ? { name } : {}),
          ...(slug !== undefined ? { slug } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        return r.ok ? ok(r.value.organization) : r;
      },
      delete: (input) => call<{ ok: true }>("POST", "/organizations/delete", input),
      members: {
        async list(input) {
          const r = await call<{ members: MemberJSON[] }>(
            "GET",
            `/organizations/members?organizationId=${encodeURIComponent(input.organizationId)}`,
          );
          return r.ok ? ok(r.value.members) : r;
        },
        async add(input) {
          const r = await call<{ member: MemberJSON }>("POST", "/organizations/members/add", input);
          return r.ok ? ok(r.value.member) : r;
        },
        async role(input) {
          const r = await call<{ member: MemberJSON }>(
            "POST",
            "/organizations/members/role",
            input,
          );
          return r.ok ? ok(r.value.member) : r;
        },
        remove: (input) => call<{ ok: true }>("POST", "/organizations/members/remove", input),
      },
      invitations: {
        async invite(input) {
          const r = await call<{ invitation: InvitationJSON }>(
            "POST",
            "/organizations/invite",
            input,
          );
          return r.ok ? ok(r.value.invitation) : r;
        },
        async list(input) {
          const r = await call<{ invitations: InvitationJSON[] }>(
            "GET",
            `/organizations/invitations?organizationId=${encodeURIComponent(input.organizationId)}`,
          );
          return r.ok ? ok(r.value.invitations) : r;
        },
        revoke: (input) => call<{ ok: true }>("POST", "/organizations/invitations/revoke", input),
        accept: (input) =>
          call<{ organization: OrganizationJSON; member: MemberJSON }>(
            "POST",
            "/organizations/invitations/accept",
            input,
          ),
        decline: (input) => call<{ ok: true }>("POST", "/organizations/invitations/decline", input),
      },
      setActive: (input) => call<PublicSession>("POST", "/organizations/active", input),
    },
    tokens: {
      create: ({ expiresInDays, organizationId, ...rest }) =>
        call<{ token: string; apiToken: ApiTokenSummaryJSON }>("POST", "/tokens", {
          ...rest,
          ...(expiresInDays !== undefined ? { expiresInDays } : {}),
          ...(organizationId !== undefined ? { organizationId } : {}),
        }),
      async list() {
        const r = await call<{ tokens: ApiTokenSummaryJSON[] }>("GET", "/tokens");
        return r.ok ? ok(r.value.tokens) : r;
      },
      revoke: (input) => call<{ ok: true }>("POST", "/tokens/revoke", input),
      current: () =>
        call<{ user: PublicSession["user"]; apiToken: ApiTokenSummaryJSON }>(
          "GET",
          "/tokens/current",
        ),
    },
    errors: ERRORS,
  };
}
