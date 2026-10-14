import type {
  ApiTokenSummary,
  InvitationSummary,
  MemberSummary,
  OAuthGrantSummary,
  OrganizationSummary,
  PasskeySummary,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  PublicSession,
} from "@authtempo/core";
import { ERRORS } from "@authtempo/core/errors";
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

/** One OAuth grant of the signed-in person (plan 9g final fix wave). */
export type OAuthGrantJSON = Omit<OAuthGrantSummary, "createdAt"> & { createdAt: string };

/** A method that a challenge offers, in the order of preference (plan 12c). */
export type ChallengeMethodJSON = "passkey" | "totp" | "email" | "backup";

/**
 * The answer of a flow whose user has the second factor on (plan 9f): no
 * session yet. The password sign-in, the reset, the magic link, the email
 * code, and social answer it (plan 12c). Call `totp.verify` with one method
 * of `methods`, or `secondFactor.passkey.verify` for `passkey`.
 */
export interface TwoFactorChallengeJSON {
  twoFactor: { challenge: string; expiresAt: string; methods: ChallengeMethodJSON[] };
}

/** A method's enable: the methods that are on, and the backup codes, answered once with the first method (else empty). */
export interface SecondFactorEnableJSON {
  methods: ("totp" | "passkey" | "email")[];
  backupCodes: string[];
}
export interface TotpStatusJSON {
  /** True when the second factor is on, by any method. */
  enabled: boolean;
  enabledAt: string | null;
  backupCodesLeft: number;
  trustedDevices: number;
  /** The methods that are on: `totp`, `passkey`, `email`. */
  methods: ("totp" | "passkey" | "email")[];
  /** 1 for an old list of short codes; ask the person to make new codes. Null when the factor is off. */
  backupCodesVersion: number | null;
}
export type TwoFactorSessionJSON = { token: string } & PublicSession & {
    next: string;
    backupCodesLeft: number;
    /** Set when the verify asked for it. A native app sends `token` as `trustDevice` at the next sign-in. */
    trustDevice: { token: string; expiresAt: string } | null;
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
    /**
     * The JSON verify: the session answer with the cookie, or `{ twoFactor }`
     * for a user with the second factor on (plan 12c). A form post is the
     * page's job, not the client's.
     */
    verify(input: {
      token: string;
      trustDevice?: string | undefined;
    }): Promise<ClientResult<PublicSession | TwoFactorChallengeJSON>>;
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
   * By default the server answers `{ sent: true }` and opens the session at the verify link (plan 12b).
   * With the server's `password.uniformSignUp: false` and `password.requireVerified` on, or `signUp: "invited"`, `signUp` answers `{ user, verifyRequired: true }` and no token.
   */
  password: {
    signUp(input: { email: string; password: string; name?: string | undefined }): Promise<
      ClientResult<
        // The third shape is the default (plan 12b). The second: uniformSignUp off and
        // requireVerified on. Neither opens a session.
        | ({ token: string } & PublicSession)
        | { user: PublicSession["user"]; verifyRequired: true }
        | { sent: true }
      >
    >;
    /**
     * A session, or `{ twoFactor }` for a user with the second factor on
     * (plan 9f): then call `totp.verify` with the challenge. `trustDevice` is
     * a native app's token from an earlier verify; a browser sends the cookie.
     */
    signIn(input: {
      email: string;
      password: string;
      trustDevice?: string | undefined;
      next?: string | undefined;
    }): Promise<ClientResult<({ token: string } & PublicSession) | TwoFactorChallengeJSON>>;
    /** A new verify link. Always `{ sent: true }`, except `rate_limited`, so it does not tell whether the address has an account. */
    resendVerification(input: { email: string }): Promise<ClientResult<{ sent: true }>>;
    /** The JSON verify of the link's token. Sets the session cookie when the address was unverified. */
    verifyEmail(input: { token: string }): Promise<ClientResult<{ verified: true }>>;
    requestReset(input: {
      email: string;
      next?: string | undefined;
    }): Promise<ClientResult<{ sent: true }>>;
    /** A session, or `{ twoFactor }` for a user with the second factor on (plan 12c): the password is set and every session ended. */
    reset(input: {
      token: string;
      password: string;
      trustDevice?: string | undefined;
    }): Promise<ClientResult<({ token: string } & PublicSession) | TwoFactorChallengeJSON>>;
    change(input: {
      currentPassword?: string | undefined;
      newPassword: string;
    }): Promise<ClientResult<{ ok: true }>>;
  };
  /**
   * Email codes (plan 9e). Every operation answers `not_found` when the
   * server sets `emailOtp: false`, and the two reset operations also when the
   * server has no `password` config. `verify` and `reset` answer the bearer
   * token: a browser app keeps the cookie, and a native app stores the token.
   */
  emailOtp: {
    request(input: { email: string }): Promise<ClientResult<{ sent: true }>>;
    verify(input: {
      email: string;
      code: string;
      trustDevice?: string | undefined;
    }): Promise<ClientResult<({ token: string } & PublicSession) | TwoFactorChallengeJSON>>;
    requestReset(input: { email: string }): Promise<ClientResult<{ sent: true }>>;
    reset(input: {
      email: string;
      code: string;
      password: string;
      trustDevice?: string | undefined;
    }): Promise<ClientResult<({ token: string } & PublicSession) | TwoFactorChallengeJSON>>;
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
  /**
   * A signed JWT of the caller's session (plan 9g), for a server that
   * verifies it offline against `<basePath>/jwks`. Needs a session: a `tk_`
   * token answers `unauthorized`. It lives `jwtMint.ttlMinutes`; a sign-out does not end it.
   */
  jwt: {
    token(): Promise<ClientResult<{ token: string }>>;
  };
  /**
   * The OAuth grants of the signed-in person (plan 9g final fix wave), for
   * a "connected apps" page. Both calls need a session: a token answers
   * `unauthorized`. Both answer `not_found` when the server runs without
   * `oauth`. `revoke` ends the client's consent and refresh tokens, and
   * answers `{ ok: true }` also when the client had none.
   */
  oauth: {
    grants(): Promise<ClientResult<OAuthGrantJSON[]>>;
    revoke(input: { clientId: string }): Promise<ClientResult<{ ok: true }>>;
  };
  /**
   * The TOTP second factor (plan 9f). Every call but `verify` needs a
   * session; a token answers `unauthorized`. Every call answers `not_found`
   * when the server runs without `password` or with `totp: false`.
   */
  totp: {
    /**
     * The secret, the key URI, and the backup codes, each answered once. Takes
     * the user's password: a wrong one answers `invalid_credentials`, and no
     * setup is written.
     */
    setup(input: {
      password: string;
    }): Promise<ClientResult<{ secret: string; uri: string; backupCodes: string[] }>>;
    enable(input: { code: string }): Promise<ClientResult<TotpStatusJSON>>;
    verify(input: {
      challenge: string;
      code?: string | undefined;
      backupCode?: string | undefined;
      emailCode?: string | undefined;
      trustDevice?: boolean | undefined;
    }): Promise<ClientResult<TwoFactorSessionJSON>>;
    /** `code` is a current code or a backup code. */
    disable(input: { code: string }): Promise<ClientResult<{ ok: true }>>;
    regenerateBackupCodes(input: {
      code: string;
    }): Promise<ClientResult<{ backupCodes: string[] }>>;
    status(): Promise<ClientResult<TotpStatusJSON>>;
    revokeTrustedDevices(): Promise<ClientResult<{ ok: true }>>;
  };
  /**
   * The second-factor methods beside TOTP (plan 12c). The enable and the
   * disable need a session and the password; `passkey.verify` and
   * `email.send` take the challenge of a sign-in. Every call answers
   * `not_found` when the server runs without `password` or with
   * `totp: false`, and the passkey calls also without the `passkey` config.
   */
  secondFactor: {
    passkey: {
      /** Asks the browser for a passkey of the user, then turns the method on. */
      enable(input: { password: string }): Promise<ClientResult<SecondFactorEnableJSON>>;
      /** Asks the browser for a passkey over the challenge's options, then verifies the challenge. */
      verify(input: {
        challenge: string;
        trustDevice?: boolean | undefined;
      }): Promise<ClientResult<TwoFactorSessionJSON>>;
    };
    email: {
      enable(input: { password: string }): Promise<ClientResult<SecondFactorEnableJSON>>;
      /** Mails a code for this challenge. Then call `totp.verify` with `emailCode`. */
      send(input: { challenge: string }): Promise<ClientResult<{ sent: true }>>;
    };
    /** Turns the passkey or the email method off. With no method left, the factor is off. */
    disable(input: {
      method: "passkey" | "email";
      password: string;
    }): Promise<ClientResult<{ ok: true; methods: ("totp" | "passkey" | "email")[] }>>;
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
      verify: ({ token, trustDevice }) =>
        call<PublicSession | TwoFactorChallengeJSON>("POST", "/magic-link/verify", {
          token,
          ...(trustDevice !== undefined ? { trustDevice } : {}),
        }),
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
        call<
          | ({ token: string } & PublicSession)
          | { user: PublicSession["user"]; verifyRequired: true }
          | { sent: true }
        >("POST", "/password/sign-up", {
          ...rest,
          ...(name !== undefined ? { name } : {}),
        }),
      signIn: ({ trustDevice, next, ...rest }) =>
        call<({ token: string } & PublicSession) | TwoFactorChallengeJSON>(
          "POST",
          "/password/sign-in",
          {
            ...rest,
            ...(trustDevice !== undefined ? { trustDevice } : {}),
            ...(next !== undefined ? { next } : {}),
          },
        ),
      resendVerification: (input) => call<{ sent: true }>("POST", "/password/verify/resend", input),
      verifyEmail: (input) => call<{ verified: true }>("POST", "/password/verify", input),
      requestReset: ({ next, ...rest }) =>
        call<{ sent: true }>("POST", "/password/reset/request", {
          ...rest,
          ...(next !== undefined ? { next } : {}),
        }),
      reset: ({ trustDevice, ...rest }) =>
        call<({ token: string } & PublicSession) | TwoFactorChallengeJSON>(
          "POST",
          "/password/reset",
          { ...rest, ...(trustDevice !== undefined ? { trustDevice } : {}) },
        ),
      change: ({ currentPassword, newPassword }) =>
        call<{ ok: true }>("POST", "/password/change", {
          ...(currentPassword !== undefined ? { currentPassword } : {}),
          newPassword,
        }),
    },
    emailOtp: {
      request: ({ email }) => call<{ sent: true }>("POST", "/otp/request", { email }),
      verify: ({ email, code, trustDevice }) =>
        call<({ token: string } & PublicSession) | TwoFactorChallengeJSON>("POST", "/otp/verify", {
          email,
          code,
          ...(trustDevice !== undefined ? { trustDevice } : {}),
        }),
      requestReset: ({ email }) => call<{ sent: true }>("POST", "/otp/reset/request", { email }),
      reset: ({ email, code, password, trustDevice }) =>
        call<({ token: string } & PublicSession) | TwoFactorChallengeJSON>("POST", "/otp/reset", {
          email,
          code,
          password,
          ...(trustDevice !== undefined ? { trustDevice } : {}),
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
    jwt: {
      token: () => call<{ token: string }>("GET", "/token"),
    },
    oauth: {
      async grants() {
        const r = await call<{ grants: OAuthGrantJSON[] }>("GET", "/oauth/grants");
        return r.ok ? ok(r.value.grants) : r;
      },
      revoke: (input) =>
        call<{ ok: true }>("POST", "/oauth/grants/revoke", { clientId: input.clientId }),
    },
    totp: {
      setup: (input) =>
        call<{ secret: string; uri: string; backupCodes: string[] }>("POST", "/totp/setup", {
          password: input.password,
        }),
      enable: (input) => call<TotpStatusJSON>("POST", "/totp/enable", input),
      verify: ({ code, backupCode, emailCode, trustDevice, ...rest }) =>
        call<TwoFactorSessionJSON>("POST", "/totp/verify", {
          ...rest,
          ...(code !== undefined ? { code } : {}),
          ...(backupCode !== undefined ? { backupCode } : {}),
          ...(emailCode !== undefined ? { emailCode } : {}),
          ...(trustDevice !== undefined ? { trustDevice } : {}),
        }),
      disable: (input) => call<{ ok: true }>("POST", "/totp/disable", input),
      regenerateBackupCodes: (input) =>
        call<{ backupCodes: string[] }>("POST", "/totp/backup-codes", input),
      status: () => call<TotpStatusJSON>("GET", "/totp"),
      revokeTrustedDevices: () => call<{ ok: true }>("POST", "/totp/devices/revoke", {}),
    },
    secondFactor: {
      passkey: {
        async enable({ password }) {
          // The enable's proof is a sign-in assertion by a passkey of this user (plan 12c).
          const options = await call<PublicKeyCredentialRequestOptionsJSON>(
            "POST",
            "/passkey/authenticate/options",
            {},
          );
          if (!options.ok) return options;
          const response = await ceremony(() => webauthn.get(options.value));
          if (!response.ok) return response;
          return call<SecondFactorEnableJSON>("POST", "/second-factor/passkey/enable", {
            password,
            response: response.value,
          });
        },
        async verify({ challenge, trustDevice }) {
          const options = await call<PublicKeyCredentialRequestOptionsJSON>(
            "POST",
            "/second-factor/passkey/options",
            { challenge },
          );
          if (!options.ok) return options;
          const response = await ceremony(() => webauthn.get(options.value));
          if (!response.ok) return response;
          return call<TwoFactorSessionJSON>("POST", "/totp/verify", {
            challenge,
            passkey: response.value,
            ...(trustDevice !== undefined ? { trustDevice } : {}),
          });
        },
      },
      email: {
        enable: ({ password }) =>
          call<SecondFactorEnableJSON>("POST", "/second-factor/email/enable", { password }),
        send: ({ challenge }) =>
          call<{ sent: true }>("POST", "/second-factor/email/send", { challenge }),
      },
      disable: ({ method, password }) =>
        call<{ ok: true; methods: ("totp" | "passkey" | "email")[] }>(
          "POST",
          "/second-factor/disable",
          { method, password },
        ),
    },
    errors: ERRORS,
  };
}
