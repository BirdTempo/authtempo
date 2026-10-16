import type {
  ApiTokenSummary,
  IdentityEntry,
  InvitationSummary,
  MemberSummary,
  OAuthGrantSummary,
  OrganizationSummary,
  PasskeySummary,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  PublicSession,
  PublicUser,
  SessionSummary,
} from "@authtempo/core";
import { ERRORS, type ErrorCode, type OAuthErrorCode } from "@authtempo/core/errors";
import { PROVIDER_NAME_RE, type RouteMethod } from "@authtempo/core/routes";
import { type ClientOperation, callOf } from "./calls.js";
import { readRedirectError } from "./redirect-error.js";
import { type ClientFailure, type ClientResult, fail, ok } from "./result.js";
import {
  createSessionStore,
  SESSION_CHANNEL,
  type SessionState,
  type SessionStore,
} from "./store.js";
import { createRawTransport, type Query, routeURL, type TransportOptions } from "./transport.js";
import {
  type BrowserWebAuthn,
  browserWebAuthn,
  type CeremonyOptions,
  supportsAutofill,
  WebAuthnCancelled,
} from "./webauthn.js";

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

/** One live session of the signed-in person (plan 12a). It holds no token. */
export type SessionSummaryJSON = Omit<
  SessionSummary,
  "createdAt" | "lastSeenAt" | "expiresAt" | "freshAt"
> & { createdAt: string; lastSeenAt: string; expiresAt: string; freshAt: string | null };
/** The user of a profile or address answer (plan 12a). */
export type PublicUserJSON = PublicUser;
/** One linked identity (plan 12a). `email` is set for the `email` identity only. */
export type IdentityEntryJSON = Omit<IdentityEntry, "linkedAt"> & { linkedAt: string };
/** The ways in of the signed-in person (plan 12a). */
export interface IdentityListJSON {
  identities: IdentityEntryJSON[];
  password: boolean;
  passkeys: number;
}
/** The answer of a re-authentication: the end of the fresh window. The session token stays. */
export interface FreshJSON {
  freshUntil: string;
}

export interface ClientOptions extends TransportOptions {
  /** The browser WebAuthn seam. Default `browserWebAuthn()`. Tests inject a soft one. */
  webauthn?: BrowserWebAuthn | undefined;
  /**
   * Tell the other tabs of this origin after a change, and read again when one
   * tells, on the `BroadcastChannel` named `authtempo-session`. Default true
   * where the runtime has `BroadcastChannel`.
   */
  broadcast?: boolean | undefined;
  /** Read the session again when the page becomes visible. Default true where `document` exists. */
  refetchOnVisible?: boolean | undefined;
  /**
   * Runs when `session()` answers null to a read that sent a token: the token
   * is dead, and the app clears it from its store (plan 11d). After the clear,
   * a read sends no token and runs no handler. `sent` is the token that the
   * read sent: clear the store only when it still holds that token, because a
   * newer sign-in may have written another one since.
   */
  onSessionEnd?: ((sent: string) => void | Promise<void>) | undefined;
  /** Sends the browser to a URL: the social start. Default `location.assign`. Tests and a router inject one. */
  navigate?: ((url: string) => void) | undefined;
}

/** The state of `client.store`. */
export type ClientSessionState = SessionState<PublicSession, ClientFailure>;

/** The answer of `client.signIn.password` (plan 11d): a session, or the second factor step. */
export type PasswordSignIn =
  | { kind: "session"; session: { token: string } & PublicSession }
  | {
      kind: "second-factor";
      challenge: string;
      expiresAt: string;
      /** The methods that this challenge takes, in the order of preference (plan 12c). */
      methods: ChallengeMethodJSON[];
      /**
       * Ends the step with a current code, a backup code, or an email code. Get an
       * email code with `secondFactor.email.send({ challenge })`. For the passkey
       * method, call `secondFactor.passkey.verify({ challenge })` instead.
       * `trustDevice` asks core to trust this device.
       */
      verify(
        factor: { code: string } | { backupCode: string } | { emailCode: string },
        options?: { trustDevice?: boolean | undefined },
      ): Promise<ClientResult<TwoFactorSessionJSON>>;
    };

export interface Client {
  session: {
    /**
     * The caller's session, or null when the API answers 401. A null is a normal state, not a failure.
     * With core's `session.deferRefresh` on, the answer holds `needsRefresh` (plan 12a).
     */
    (): Promise<ClientResult<PublicSession | null>>;
    /**
     * `POST /session/refresh` (plan 12a): slides the expiry when the refresh is
     * due, and renews the cookie. Call it when `session()` answers
     * `needsRefresh: true`. It answers as `session()` does, and the store reads again.
     */
    refresh(): Promise<ClientResult<PublicSession | null>>;
  };
  signOut(): Promise<ClientResult<{ ok: true }>>;
  /**
   * The error code of a URL that a browser flow failure landed on
   * (`?auth_error=<code>`): a code of core's `ERRORS` or `OAUTH_ERRORS`,
   * `unexpected` for an unknown code, or null.
   */
  readRedirectError(url: string | URL): ErrorCode | OAuthErrorCode | "unexpected" | null;
  /** Social sign-in in a browser (plan 11d). A native app rides a social sign-in through the handoff's `next`. */
  social: {
    /** The URL of `GET <basePath>/social/:provider/start`. `invalid_body` with status 0 for a name that core refuses. */
    startURL(input: { provider: string; next?: string | undefined }): ClientResult<string>;
    /** Sends the browser to the start URL through `navigate`. With the default `navigate` and no `location`, it answers `unexpected` with status 0. */
    signIn(input: { provider: string; next?: string | undefined }): ClientResult<{ url: string }>;
  };
  /** Sign-ins in one call (plan 11d). */
  signIn: {
    /** `password.signIn`, with the second factor step as an object whose `verify` ends it. */
    password(input: {
      email: string;
      password: string;
      trustDevice?: string | undefined;
      next?: string | undefined;
      /** The captcha widget's token (plan 12b). The client sends it in the header `x-captcha-response`. */
      captchaToken?: string | undefined;
    }): Promise<ClientResult<PasswordSignIn>>;
  };
  /**
   * The session store (plan 11d): one read at the first subscriber, and one
   * after each call that changes the session (every sign-in, the sign-out,
   * the second factor verify and enable, a password reset or change, the
   * address verify, the active organization, an organization delete or a
   * member remove, and the handoff redeem), after
   * another tab's change, and when the page becomes visible. No poll. The
   * revoke of a session, a profile update, an address change confirm, and
   * the account delete change the session too (plan 12a).
   */
  store: SessionStore<PublicSession, ClientFailure>;
  magicLink: {
    request(input: {
      email: string;
      next?: string | undefined;
      /** The captcha widget's token (plan 12b). The client sends it in the header `x-captcha-response`. */
      captchaToken?: string | undefined;
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
    /**
     * A discoverable-credential sign-in. Answers the session; the browser gets
     * the cookie. With `autofill: true` the browser waits for the person to pick
     * a passkey from the autofill of a field with `autocomplete="username
     * webauthn"`; where the browser has no conditional mediation it answers
     * `cancelled` with no request (plan 11d).
     */
    signIn(input?: { autofill?: boolean | undefined }): Promise<ClientResult<PublicSession>>;
    /** Ends a waiting passkey ceremony, the autofill or another. It answers `cancelled`. */
    abort(): void;
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
    signUp(input: {
      email: string;
      password: string;
      name?: string | undefined;
      /** The captcha widget's token (plan 12b). The client sends it in the header `x-captcha-response`. */
      captchaToken?: string | undefined;
    }): Promise<
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
      /** The captcha widget's token (plan 12b). The client sends it in the header `x-captcha-response`. */
      captchaToken?: string | undefined;
    }): Promise<ClientResult<({ token: string } & PublicSession) | TwoFactorChallengeJSON>>;
    /** A new verify link. Always `{ sent: true }`, except `rate_limited`, so it does not tell whether the address has an account. */
    resendVerification(input: { email: string }): Promise<ClientResult<{ sent: true }>>;
    /** The JSON verify of the link's token. Sets the session cookie when the address was unverified. */
    verifyEmail(input: { token: string }): Promise<ClientResult<{ verified: true }>>;
    requestReset(input: {
      email: string;
      next?: string | undefined;
      /** The captcha widget's token (plan 12b). The client sends it in the header `x-captcha-response`. */
      captchaToken?: string | undefined;
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
    /** `captchaToken`: the captcha widget's token (plan 12b), sent in the header `x-captcha-response`. */
    request(input: {
      email: string;
      captchaToken?: string | undefined;
    }): Promise<ClientResult<{ sent: true }>>;
    verify(input: {
      email: string;
      code: string;
      trustDevice?: string | undefined;
    }): Promise<ClientResult<({ token: string } & PublicSession) | TwoFactorChallengeJSON>>;
    /** `captchaToken`: as in `request`. */
    requestReset(input: {
      email: string;
      captchaToken?: string | undefined;
    }): Promise<ClientResult<{ sent: true }>>;
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
  /**
   * The sessions of the signed-in person (plan 12a). The two revokes need a
   * fresh session, else they answer `session_not_fresh`.
   */
  sessions: {
    list(): Promise<ClientResult<SessionSummaryJSON[]>>;
    /**
     * Ends one session. `current` is true when `id` is the caller's own
     * session: that session has ended, and a bearer app clears its token.
     */
    revoke(input: { id: string }): Promise<ClientResult<{ ok: true; current: boolean }>>;
    /** Ends every other session of the person. `ended` is the count. */
    revokeOthers(): Promise<ClientResult<{ ended: number }>>;
  };
  /** The re-authentication (plan 12a). Each proof makes the session fresh and keeps its token. */
  reauth: {
    /** `code` is the authenticator code or a backup code. It is necessary while the second factor is on. */
    password(input: {
      password: string;
      code?: string | undefined;
    }): Promise<ClientResult<FreshJSON>>;
    /** Mails a code to the account's address. `not_found` when the server sets `emailOtp: false`. */
    requestEmailCode(): Promise<ClientResult<{ sent: true }>>;
    emailCode(input: {
      emailCode: string;
      code?: string | undefined;
    }): Promise<ClientResult<FreshJSON>>;
    /** The options, the browser prompt, and the proof. A dismissed prompt is `cancelled`. */
    passkey(): Promise<ClientResult<FreshJSON>>;
  };
  /** The profile, the address, and the delete of the signed-in person (plan 12a). */
  user: {
    /** `null` clears a field. A field that the caller leaves out stays. */
    update(input: {
      name?: string | null | undefined;
      image?: string | null | undefined;
    }): Promise<ClientResult<{ user: PublicUserJSON }>>;
    /**
     * Needs a fresh session. A proof goes to the new address. The answer is
     * the same when another account holds that address.
     */
    changeEmail(input: {
      newEmail: string;
      method?: "link" | "code" | undefined;
      next?: string | undefined;
    }): Promise<ClientResult<{ sent: true }>>;
    /** The token of the mailed link, for an app that serves its own confirm page. Needs no session. */
    confirmEmailChange(input: { token: string }): Promise<ClientResult<{ user: PublicUserJSON }>>;
    /** The mailed code of `changeEmail({ method: "code" })`. */
    verifyEmailChange(input: { code: string }): Promise<ClientResult<{ user: PublicUserJSON }>>;
    /** Needs a fresh session. The account and the caller's session end. */
    delete(): Promise<ClientResult<{ ok: true }>>;
  };
  /** The linked identities of the signed-in person (plan 12a). */
  identities: {
    list(): Promise<ClientResult<IdentityListJSON>>;
    /** Needs a fresh session. `last_credential` when the identity is the last way in. */
    unlink(input: { id: string }): Promise<ClientResult<{ ok: true }>>;
    /**
     * Needs a fresh session. Posts the start, then sends the browser to the
     * provider through `navigate`. `invalid_body` with status 0 for a name
     * that core refuses.
     */
    link(input: {
      provider: string;
      next?: string | undefined;
    }): Promise<ClientResult<{ url: string }>>;
  };
  /**
   * Runs `op`. On `session_not_fresh` it runs `reauth`, a prompt of the app's
   * own page, and after its success it runs `op` once more. A second
   * `session_not_fresh` is the answer: the function never loops. A failed
   * `reauth` is the answer, and `op` does not run again.
   */
  withFresh<T>(
    op: () => Promise<ClientResult<T>>,
    reauth: () => Promise<ClientResult<unknown>>,
  ): Promise<ClientResult<T>>;
  errors: typeof ERRORS;
}

/**
 * The header of the captcha token: core's `CAPTCHA_HEADER` (plan 12b). The
 * client does not import core's root, so the name is here, and
 * test/password.test.ts compares it with core's.
 */
const CAPTCHA_HEADER = "x-captcha-response";

function captchaHeader(token: string | undefined): Record<string, string> | undefined {
  return token !== undefined ? { [CAPTCHA_HEADER]: token } : undefined;
}

/** A plain object, not an array and not null. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The shape of core's session answer (`PublicSession`): a user and a session,
 * each with a string id. A 200 of another shape (another JSON service at the
 * baseURL, a captive portal) is not a session, as the OAuth client and the
 * verifier already hold (plan 11d Task 13 review, M1).
 */
function isPublicSession(v: unknown): v is PublicSession {
  return (
    isRecord(v) &&
    isRecord(v.user) &&
    typeof v.user.id === "string" &&
    isRecord(v.session) &&
    typeof v.session.id === "string" &&
    // Present with core's session.deferRefresh on only (plan 12a).
    (v.needsRefresh === undefined || typeof v.needsRefresh === "boolean")
  );
}

/**
 * The row with each `:name` of its path filled from `params` (plan 12a). The
 * link start's path names the provider. A name that `params` lacks stays.
 */
function filled(
  row: { method: RouteMethod; path: string },
  params: Readonly<Record<string, string>> | undefined,
): { method: RouteMethod; path: string } {
  if (!params) return row;
  const path = row.path.replace(/:([A-Za-z]+)/g, (name, key: string) => {
    const value = params[key];
    return value === undefined ? name : encodeURIComponent(value);
  });
  return { method: row.method, path };
}

/** A 200 that fails `is` answers `unexpected` with status 200 (the plan 11d rule). */
async function shaped<T>(
  p: Promise<ClientResult<unknown>>,
  is: (v: unknown) => v is T,
): Promise<ClientResult<T>> {
  const r = await p;
  if (!r.ok) return r;
  return is(r.value) ? ok(r.value) : fail("unexpected", 200);
}

const isOkTrue = (v: unknown): v is { ok: true } => isRecord(v) && v.ok === true;
const isSent = (v: unknown): v is { sent: true } => isRecord(v) && v.sent === true;
const isFresh = (v: unknown): v is FreshJSON => isRecord(v) && typeof v.freshUntil === "string";
const isEnded = (v: unknown): v is { ended: number } => isRecord(v) && typeof v.ended === "number";
const isRevoked = (v: unknown): v is { ok: true; current: boolean } =>
  isRecord(v) && v.ok === true && typeof v.current === "boolean";
const isUserAnswer = (v: unknown): v is { user: PublicUserJSON } =>
  isRecord(v) &&
  isRecord(v.user) &&
  typeof v.user.id === "string" &&
  typeof v.user.email === "string";
const isSessionList = (v: unknown): v is { sessions: SessionSummaryJSON[] } =>
  isRecord(v) &&
  Array.isArray(v.sessions) &&
  v.sessions.every(
    (s) => isRecord(s) && typeof s.id === "string" && typeof s.current === "boolean",
  );
const isIdentityList = (v: unknown): v is IdentityListJSON =>
  isRecord(v) &&
  Array.isArray(v.identities) &&
  v.identities.every(
    (e) =>
      isRecord(e) &&
      typeof e.id === "string" &&
      typeof e.provider === "string" &&
      typeof e.canUnlink === "boolean",
  ) &&
  typeof v.password === "boolean" &&
  typeof v.passkeys === "number";
const isRequestOptions = (v: unknown): v is PublicKeyCredentialRequestOptionsJSON =>
  isRecord(v) && typeof v.challenge === "string";

/** An `http:` or `https:` URL. The client navigates to no other scheme, such as `javascript:`. */
function isWebURL(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const { protocol } = new URL(v);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
const isLinkStart = (v: unknown): v is { url: string } => isRecord(v) && isWebURL(v.url);

export function createClient(options: ClientOptions): Client {
  const call = createRawTransport(options);
  /**
   * One operation of `CLIENT_CALLS`: its method and path come from the table
   * (plan 11d). `params` fills a template path, such as the provider of a link.
   */
  const send = <T>(
    operation: ClientOperation,
    body?: unknown,
    query?: Query,
    headers?: Readonly<Record<string, string>>,
    token?: string | null,
    params?: Readonly<Record<string, string>>,
  ) => {
    const c = filled(callOf(operation), params);
    return call<T>(c.method, c.path, body, query, headers, token);
  };
  /** `session()` and `session.refresh()`: one read rule for the GET and the POST (plan 12a). */
  async function readSession(
    operation: "session" | "session.refresh",
  ): Promise<ClientResult<PublicSession | null>> {
    // The token this read sends. `options.token` is a function and is always set, so the end
    // handler keys on its answer: after the app clears the token, a 401 runs no handler, and a
    // sign-out or a refetch inside the handler ends (plan 11d Task 5 review, J2).
    // One read of the token for the header and for the handler: two reads could answer two
    // different tokens (plan 11d Task 12 review, J1).
    const sent = options.token ? await options.token() : null;
    const body = operation === "session" ? undefined : {};
    const r = await send<PublicSession>(operation, body, undefined, undefined, sent);
    if (!r.ok && r.code === "unauthorized") {
      // A bearer client's token is dead: the app clears it (the client README rule, plan 11d).
      // A store that fails to clear must not turn an answer into a throw.
      const end = options.onSessionEnd;
      // An empty token sends no header (the transport), so it counts as cleared (plan 11d Task 5 re-review, N1).
      if (sent && end)
        await Promise.resolve()
          .then(() => end(sent))
          .catch(() => {});
      return ok(null);
    }
    if (r.ok && r.value !== null && !isPublicSession(r.value)) return fail("unexpected", 200);
    return r;
  }
  /**
   * The store's read (plan 12a Task 17 review, L1). With core's
   * `session.deferRefresh` on, a due session is refreshed here, so a page
   * that only reads the store keeps an active session alive. A failed
   * refresh keeps the GET answer. Better Auth 1.7.2's session atom does the
   * same (dist/client/session-atom.mjs:66 to :80, read 2026-10-17).
   */
  async function readLive(): Promise<ClientResult<PublicSession | null>> {
    const r = await readSession("session");
    if (!r.ok || r.value?.needsRefresh !== true) return r;
    const refreshed = await readSession("session.refresh");
    return refreshed.ok ? refreshed : r;
  }
  const inner = createSessionStore<PublicSession, ClientFailure>({
    read: async () => {
      const r = await readLive();
      return r.ok ? { data: r.value, error: null } : { data: null, error: r };
    },
    onThrow: () => ({ ok: false, code: "unexpected", status: 0 }),
  });
  const broadcast = (options.broadcast ?? true) && typeof BroadcastChannel !== "undefined";
  // The listening channel and the document listener open at the first subscriber, not here.
  // A client with no subscriber (the compatibility package makes one per call) holds no
  // channel and no listener, so nothing leaks (plan 11d Task 5 review, J1).
  let channel: BroadcastChannel | null = null;
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    if (broadcast) {
      channel = new BroadcastChannel(SESSION_CHANNEL);
      // Node keeps the process alive while a channel is open; a browser has no unref.
      (channel as { unref?: () => void }).unref?.();
      channel.addEventListener("message", () => inner.refetchIfStarted());
    }
    if ((options.refetchOnVisible ?? true) && typeof document !== "undefined")
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") inner.refetchIfStarted();
      });
  };
  const store: SessionStore<PublicSession, ClientFailure> = {
    ...inner,
    subscribe(listener) {
      listen();
      return inner.subscribe(listener);
    },
  };
  /** Tells the other tabs. With no listening channel, a short one posts and closes; the message still goes out. */
  const tell = () => {
    if (channel) return channel.postMessage("changed");
    if (!broadcast) return;
    const once = new BroadcastChannel(SESSION_CHANNEL);
    once.postMessage("changed");
    once.close();
  };
  /** After a call that changes the session succeeds: read again, and tell the other tabs. */
  const changes = async <T>(p: Promise<ClientResult<T>>): Promise<ClientResult<T>> => {
    const r = await p;
    if (r.ok) {
      store.refetchIfStarted();
      tell();
    }
    return r;
  };
  // The refresh moves the expiry, so the store reads again and the other tabs hear it.
  const session: Client["session"] = Object.assign(() => readSession("session"), {
    refresh: () => changes(readSession("session.refresh")),
  });
  const webauthn = options.webauthn ?? browserWebAuthn();
  /** Runs one ceremony; a dismissed prompt is `cancelled`, any other throw is `unexpected`. */
  async function ceremony<T>(run: () => Promise<T>): Promise<ClientResult<T>> {
    try {
      return ok(await run());
    } catch (e) {
      return fail(e instanceof WebAuthnCancelled ? "cancelled" : "unexpected", 0);
    }
  }
  /** Answers false when the default finds no `location`, as in a server render: the call then fails. */
  const navigate = (url: string): boolean => {
    if (options.navigate) {
      options.navigate(url);
      return true;
    }
    const location = (globalThis as { location?: { assign?(u: string): void } }).location;
    if (typeof location?.assign !== "function") return false;
    location.assign(url);
    return true;
  };
  function startURL(input: { provider: string; next?: string | undefined }): ClientResult<string> {
    if (!PROVIDER_NAME_RE.test(input.provider)) return fail("invalid_body", 0);
    const { path } = callOf("social.start");
    return ok(
      routeURL(
        options,
        path.replace(":provider", input.provider),
        input.next !== undefined ? { next: input.next } : undefined,
      ),
    );
  }
  // One controller for every passkey get (plan 11d Task 6 review, J1 and J2). A browser refuses
  // a second pending get, so a new get ends the waiting one first. The controller exists before
  // the first await, so an abort() during the options request is not lost.
  let pending: AbortController | null = null;
  /** One get ceremony: ends the waiting get, loads the options, and runs the get with the shared signal. */
  async function assertion(
    load: () => Promise<ClientResult<PublicKeyCredentialRequestOptionsJSON>>,
    autofill = false,
  ): Promise<ClientResult<Awaited<ReturnType<BrowserWebAuthn["get"]>>>> {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    try {
      // No modal prompt on a page load: without conditional mediation the autofill answers cancelled.
      if (autofill && !(await supportsAutofill())) return fail("cancelled", 0);
      if (controller.signal.aborted) return fail("cancelled", 0);
      const options = await load();
      if (controller.signal.aborted) return fail("cancelled", 0);
      if (!options.ok) return options;
      const ceremonyOptions: CeremonyOptions = autofill
        ? { mediation: "conditional", signal: controller.signal }
        : { signal: controller.signal };
      return await ceremony(() => webauthn.get(options.value, ceremonyOptions));
    } finally {
      // A spent controller is not kept (L4).
      if (pending === controller) pending = null;
    }
  }
  const password: Client["password"] = {
    signUp: ({ name, captchaToken, ...rest }) =>
      changes(
        send<
          | ({ token: string } & PublicSession)
          | { user: PublicSession["user"]; verifyRequired: true }
          | { sent: true }
        >(
          "password.signUp",
          { ...rest, ...(name !== undefined ? { name } : {}) },
          undefined,
          captchaHeader(captchaToken),
        ),
      ),
    signIn: ({ trustDevice, next, captchaToken, ...rest }) =>
      changes(
        send<({ token: string } & PublicSession) | TwoFactorChallengeJSON>(
          "password.signIn",
          {
            ...rest,
            ...(trustDevice !== undefined ? { trustDevice } : {}),
            ...(next !== undefined ? { next } : {}),
          },
          undefined,
          captchaHeader(captchaToken),
        ),
      ),
    resendVerification: (input) => send<{ sent: true }>("password.resendVerification", input),
    verifyEmail: (input) => changes(send<{ verified: true }>("password.verifyEmail", input)),
    requestReset: ({ next, captchaToken, ...rest }) =>
      send<{ sent: true }>(
        "password.requestReset",
        { ...rest, ...(next !== undefined ? { next } : {}) },
        undefined,
        captchaHeader(captchaToken),
      ),
    reset: ({ trustDevice, ...rest }) =>
      changes(
        send<({ token: string } & PublicSession) | TwoFactorChallengeJSON>("password.reset", {
          ...rest,
          ...(trustDevice !== undefined ? { trustDevice } : {}),
        }),
      ),
    change: ({ currentPassword, newPassword }) =>
      changes(
        send<{ ok: true }>("password.change", {
          ...(currentPassword !== undefined ? { currentPassword } : {}),
          newPassword,
        }),
      ),
  };
  const totp: Client["totp"] = {
    setup: (input) =>
      send<{ secret: string; uri: string; backupCodes: string[] }>("totp.setup", {
        password: input.password,
      }),
    enable: (input) => changes(send<TotpStatusJSON>("totp.enable", input)),
    verify: ({ code, backupCode, emailCode, trustDevice, ...rest }) =>
      changes(
        send<TwoFactorSessionJSON>("totp.verify", {
          ...rest,
          ...(code !== undefined ? { code } : {}),
          ...(backupCode !== undefined ? { backupCode } : {}),
          ...(emailCode !== undefined ? { emailCode } : {}),
          ...(trustDevice !== undefined ? { trustDevice } : {}),
        }),
      ),
    disable: (input) => send<{ ok: true }>("totp.disable", input),
    regenerateBackupCodes: (input) =>
      send<{ backupCodes: string[] }>("totp.regenerateBackupCodes", input),
    status: () => send<TotpStatusJSON>("totp.status"),
    revokeTrustedDevices: () => send<{ ok: true }>("totp.revokeTrustedDevices", {}),
  };
  const sessions: Client["sessions"] = {
    list: async () => {
      const r = await shaped(send<unknown>("sessions.list"), isSessionList);
      return r.ok ? ok(r.value.sessions) : r;
    },
    // The store reads again: the caller's own revoke ends its session. The answer's
    // `current` tells whose session ended. One read of the token (plan 11d Task 12 review, J1).
    revoke: ({ id }) =>
      changes(
        (async () => {
          const token = options.token ? await options.token() : null;
          return shaped(
            send<unknown>("sessions.revoke", { id }, undefined, undefined, token),
            isRevoked,
          );
        })(),
      ),
    revokeOthers: () => shaped(send<unknown>("sessions.revokeOthers", {}), isEnded),
  };
  const reauth: Client["reauth"] = {
    password: ({ password, code }) =>
      shaped(
        send<unknown>("reauth", { password, ...(code !== undefined ? { code } : {}) }),
        isFresh,
      ),
    requestEmailCode: () => shaped(send<unknown>("reauth.email.request", {}), isSent),
    emailCode: ({ emailCode, code }) =>
      shaped(
        send<unknown>("reauth", { emailCode, ...(code !== undefined ? { code } : {}) }),
        isFresh,
      ),
    async passkey() {
      // The shared get ceremony: it ends a waiting autofill first, as a browser refuses two.
      const response = await assertion(() =>
        shaped(send<unknown>("reauth.passkey.options", {}), isRequestOptions),
      );
      if (!response.ok) return response;
      return shaped(send<unknown>("reauth", { passkey: response.value }), isFresh);
    },
  };
  // The profile, the two confirms, and the delete change the session's user or end the
  // session, so the store reads again.
  const user: Client["user"] = {
    update: ({ name, image }) =>
      changes(
        shaped(
          send<unknown>("user.update", {
            ...(name !== undefined ? { name } : {}),
            ...(image !== undefined ? { image } : {}),
          }),
          isUserAnswer,
        ),
      ),
    changeEmail: ({ newEmail, method, next }) =>
      shaped(
        send<unknown>("user.changeEmail", {
          newEmail,
          ...(method !== undefined ? { method } : {}),
          ...(next !== undefined ? { next } : {}),
        }),
        isSent,
      ),
    confirmEmailChange: ({ token }) =>
      changes(shaped(send<unknown>("user.confirmEmailChange", { token }), isUserAnswer)),
    verifyEmailChange: ({ code }) =>
      changes(shaped(send<unknown>("user.verifyEmailChange", { code }), isUserAnswer)),
    delete: () => changes(shaped(send<unknown>("user.delete", {}), isOkTrue)),
  };
  const identities: Client["identities"] = {
    list: () => shaped(send<unknown>("identities.list"), isIdentityList),
    unlink: ({ id }) => shaped(send<unknown>("identities.unlink", { id }), isOkTrue),
    async link({ provider, next }) {
      if (!PROVIDER_NAME_RE.test(provider)) return fail("invalid_body", 0);
      const r = await shaped(
        send<unknown>(
          "identities.link",
          next !== undefined ? { next } : {},
          undefined,
          undefined,
          undefined,
          { provider },
        ),
        isLinkStart,
      );
      if (!r.ok) return r;
      if (!navigate(r.value.url)) return fail("unexpected", 0);
      return ok({ url: r.value.url });
    },
  };
  async function withFresh<T>(
    op: () => Promise<ClientResult<T>>,
    again: () => Promise<ClientResult<unknown>>,
  ): Promise<ClientResult<T>> {
    const first = await op();
    if (first.ok || first.code !== "session_not_fresh") return first;
    const proved = await again();
    if (!proved.ok) return proved;
    return op();
  }
  return {
    session,
    store,
    readRedirectError,
    social: {
      startURL,
      signIn(input) {
        const url = startURL(input);
        if (!url.ok) return url;
        if (!navigate(url.value)) return fail("unexpected", 0);
        return ok({ url: url.value });
      },
    },
    signIn: {
      async password(input) {
        const r = await password.signIn(input);
        if (!r.ok) return r;
        // A 200 of another shape answers unexpected, never a throw (final review, m1).
        const v: unknown = r.value;
        if (!isRecord(v)) return fail("unexpected", 200);
        if (!("twoFactor" in v)) {
          if (!(isPublicSession(v) && typeof (v as { token?: unknown }).token === "string"))
            return fail("unexpected", 200);
          return ok({ kind: "session", session: r.value as { token: string } & PublicSession });
        }
        const t = v.twoFactor;
        if (
          !isRecord(t) ||
          typeof t.challenge !== "string" ||
          typeof t.expiresAt !== "string" ||
          !Array.isArray(t.methods)
        )
          return fail("unexpected", 200);
        const { challenge, expiresAt, methods } = t as TwoFactorChallengeJSON["twoFactor"];
        return ok({
          kind: "second-factor",
          challenge,
          expiresAt,
          methods,
          verify: (factor, o = {}) =>
            totp.verify({
              challenge,
              ...("code" in factor
                ? { code: factor.code }
                : "backupCode" in factor
                  ? { backupCode: factor.backupCode }
                  : { emailCode: factor.emailCode }),
              ...(o.trustDevice !== undefined ? { trustDevice: o.trustDevice } : {}),
            }),
        });
      },
    },
    // The empty object makes the content type JSON and the body harmless to read; the router's POST Origin rule still applies.
    signOut: () => changes(send<{ ok: true }>("signOut", {})),
    magicLink: {
      request: ({ captchaToken, ...rest }) =>
        send<{ sent: true }>("magicLink.request", rest, undefined, captchaHeader(captchaToken)),
      verify: ({ token, trustDevice }) =>
        changes(
          send<PublicSession | TwoFactorChallengeJSON>("magicLink.verify", {
            token,
            ...(trustDevice !== undefined ? { trustDevice } : {}),
          }),
        ),
    },
    handoff: {
      // The redeem answers the session and its bearer token: another shape is not a sign-in.
      redeem: (input) =>
        changes(
          send<{ token: string } & PublicSession>("handoff.redeem", input).then((r) =>
            r.ok && !(isPublicSession(r.value) && typeof r.value.token === "string")
              ? fail("unexpected", 200)
              : r,
          ),
        ),
    },
    passkey: {
      async register(input = {}) {
        // A browser refuses a create while a get waits, so end a waiting autofill first (plan 11d Task 6 re-review, N3).
        pending?.abort();
        pending = null;
        const options = await send<PublicKeyCredentialCreationOptionsJSON>(
          "passkey.register.options",
          {},
        );
        if (!options.ok) return options;
        const response = await ceremony(() => webauthn.create(options.value));
        if (!response.ok) return response;
        const r = await send<{ passkey: PasskeySummaryJSON }>("passkey.register.verify", {
          response: response.value,
          ...(input.name !== undefined ? { name: input.name } : {}),
        });
        return r.ok ? ok(r.value.passkey) : r;
      },
      async signIn(input = {}) {
        const response = await assertion(
          () => send<PublicKeyCredentialRequestOptionsJSON>("passkey.signIn.options", {}),
          input.autofill === true,
        );
        if (!response.ok) return response;
        return changes(send<PublicSession>("passkey.signIn.verify", { response: response.value }));
      },
      abort() {
        pending?.abort();
        pending = null;
      },
    },
    passkeys: {
      async list() {
        const r = await send<{ passkeys: PasskeySummaryJSON[] }>("passkeys.list");
        return r.ok ? ok(r.value.passkeys) : r;
      },
      delete: (input) => send<{ ok: true }>("passkeys.delete", input),
    },
    password,
    emailOtp: {
      request: ({ email, captchaToken }) =>
        send<{ sent: true }>("emailOtp.request", { email }, undefined, captchaHeader(captchaToken)),
      verify: ({ email, code, trustDevice }) =>
        changes(
          send<({ token: string } & PublicSession) | TwoFactorChallengeJSON>("emailOtp.verify", {
            email,
            code,
            ...(trustDevice !== undefined ? { trustDevice } : {}),
          }),
        ),
      requestReset: ({ email, captchaToken }) =>
        send<{ sent: true }>(
          "emailOtp.requestReset",
          { email },
          undefined,
          captchaHeader(captchaToken),
        ),
      reset: ({ email, code, password, trustDevice }) =>
        changes(
          send<({ token: string } & PublicSession) | TwoFactorChallengeJSON>("emailOtp.reset", {
            email,
            code,
            password,
            ...(trustDevice !== undefined ? { trustDevice } : {}),
          }),
        ),
    },
    organizations: {
      create: ({ metadata, ...rest }) =>
        send<{ organization: OrganizationJSON; member: MemberJSON }>("organizations.create", {
          ...rest,
          ...(metadata !== undefined ? { metadata } : {}),
        }),
      async list() {
        const r = await send<{
          organizations: { organization: OrganizationJSON; role: string }[];
        }>("organizations.list");
        return r.ok ? ok(r.value.organizations) : r;
      },
      async update({ metadata, name, slug, organizationId }) {
        const r = await send<{ organization: OrganizationJSON }>("organizations.update", {
          organizationId,
          ...(name !== undefined ? { name } : {}),
          ...(slug !== undefined ? { slug } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        return r.ok ? ok(r.value.organization) : r;
      },
      // Core clears the active organization when it is deleted, so the session data changes.
      delete: (input) => changes(send<{ ok: true }>("organizations.delete", input)),
      members: {
        async list(input) {
          const r = await send<{ members: MemberJSON[] }>("organizations.members.list", undefined, {
            organizationId: input.organizationId,
          });
          return r.ok ? ok(r.value.members) : r;
        },
        async add(input) {
          const r = await send<{ member: MemberJSON }>("organizations.members.add", input);
          return r.ok ? ok(r.value.member) : r;
        },
        async role(input) {
          const r = await send<{ member: MemberJSON }>("organizations.members.role", input);
          return r.ok ? ok(r.value.member) : r;
        },
        // A member who leaves the active organization loses it from the session.
        remove: (input) => changes(send<{ ok: true }>("organizations.members.remove", input)),
      },
      invitations: {
        async invite(input) {
          const r = await send<{ invitation: InvitationJSON }>(
            "organizations.invitations.invite",
            input,
          );
          return r.ok ? ok(r.value.invitation) : r;
        },
        async list(input) {
          const r = await send<{ invitations: InvitationJSON[] }>(
            "organizations.invitations.list",
            undefined,
            { organizationId: input.organizationId },
          );
          return r.ok ? ok(r.value.invitations) : r;
        },
        revoke: (input) => send<{ ok: true }>("organizations.invitations.revoke", input),
        accept: (input) =>
          send<{ organization: OrganizationJSON; member: MemberJSON }>(
            "organizations.invitations.accept",
            input,
          ),
        decline: (input) => send<{ ok: true }>("organizations.invitations.decline", input),
      },
      setActive: (input) => changes(send<PublicSession>("organizations.setActive", input)),
    },
    tokens: {
      create: ({ expiresInDays, organizationId, ...rest }) =>
        send<{ token: string; apiToken: ApiTokenSummaryJSON }>("tokens.create", {
          ...rest,
          ...(expiresInDays !== undefined ? { expiresInDays } : {}),
          ...(organizationId !== undefined ? { organizationId } : {}),
        }),
      async list() {
        const r = await send<{ tokens: ApiTokenSummaryJSON[] }>("tokens.list");
        return r.ok ? ok(r.value.tokens) : r;
      },
      revoke: (input) => send<{ ok: true }>("tokens.revoke", input),
      current: () =>
        send<{ user: PublicSession["user"]; apiToken: ApiTokenSummaryJSON }>("tokens.current"),
    },
    jwt: {
      token: () => send<{ token: string }>("jwt.token"),
    },
    oauth: {
      async grants() {
        const r = await send<{ grants: OAuthGrantJSON[] }>("oauth.grants");
        return r.ok ? ok(r.value.grants) : r;
      },
      revoke: (input) => send<{ ok: true }>("oauth.revoke", { clientId: input.clientId }),
    },
    totp,
    secondFactor: {
      passkey: {
        async enable({ password }) {
          // The enable's proof is a sign-in assertion by a passkey of this user (plan 12c).
          const response = await assertion(() =>
            send<PublicKeyCredentialRequestOptionsJSON>("secondFactor.passkey.enable.options", {}),
          );
          if (!response.ok) return response;
          // The ended sessions are in other browsers; this origin's tabs share the cookie. The wrap keeps parity with `totp.enable`.
          return changes(
            send<SecondFactorEnableJSON>("secondFactor.passkey.enable.verify", {
              password,
              response: response.value,
            }),
          );
        },
        async verify({ challenge, trustDevice }) {
          const response = await assertion(() =>
            send<PublicKeyCredentialRequestOptionsJSON>("secondFactor.passkey.verify.options", {
              challenge,
            }),
          );
          if (!response.ok) return response;
          // The passkey verify of a challenge opens a session, as `totp.verify` does.
          return changes(
            send<TwoFactorSessionJSON>("secondFactor.passkey.verify.verify", {
              challenge,
              passkey: response.value,
              ...(trustDevice !== undefined ? { trustDevice } : {}),
            }),
          );
        },
      },
      email: {
        enable: ({ password }) =>
          changes(send<SecondFactorEnableJSON>("secondFactor.email.enable", { password })),
        send: ({ challenge }) => send<{ sent: true }>("secondFactor.email.send", { challenge }),
      },
      disable: ({ method, password }) =>
        send<{ ok: true; methods: ("totp" | "passkey" | "email")[] }>("secondFactor.disable", {
          method,
          password,
        }),
    },
    sessions,
    reauth,
    user,
    identities,
    withFresh,
    errors: ERRORS,
  };
}
