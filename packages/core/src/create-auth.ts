import { type AuthConfig, resolveConfig } from "./config.js";
import {
  type MagicLinkRequest,
  type MagicLinkVerify,
  requestMagicLink,
  verifyMagicLink,
} from "./engine/magic-link.js";
import {
  deletePasskey,
  listPasskeys,
  type PasskeySummary,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "./engine/passkeys.js";
import {
  destroySession,
  type ResolvedSession,
  readSessionToken,
  renewedSessionCookie,
  resolveSession,
} from "./engine/sessions.js";
import {
  completeSocial,
  type SocialComplete,
  type SocialStart,
  type SocialStarted,
  startSocial,
} from "./engine/social.js";
import { ERRORS } from "./errors.js";
import { createRouter } from "./http/router.js";
import { magicLinkRoutes } from "./http/routes/magic-link.js";
import { passkeyRoutes } from "./http/routes/passkeys.js";
import { sessionRoutes } from "./http/routes/sessions.js";
import { socialRoutes } from "./http/routes/social.js";
import type { Result } from "./result.js";
import type { SessionRow, UserRow } from "./schema.js";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "./seams/webauthn.js";

export interface AuthApi {
  requestMagicLink(input: MagicLinkRequest): Promise<Result<{ sent: true }>>;
  verifyMagicLink(
    input: MagicLinkVerify,
  ): Promise<Result<{ token: string; next: string; user: UserRow }>>;
  startSocial(input: SocialStart): Promise<Result<SocialStarted>>;
  completeSocial(
    input: SocialComplete,
  ): Promise<Result<{ token: string; next: string; user: UserRow }>>;
  passkeyRegistrationOptions(input: {
    user: UserRow;
  }): Promise<Result<PublicKeyCredentialCreationOptionsJSON>>;
  verifyPasskeyRegistration(input: {
    user: UserRow;
    response: unknown;
    name?: string | undefined;
  }): Promise<Result<PasskeySummary>>;
  passkeyAuthenticationOptions(input: {
    ip: string | null;
  }): Promise<Result<PublicKeyCredentialRequestOptionsJSON>>;
  verifyPasskeyAuthentication(input: {
    response: unknown;
    ip: string | null;
    userAgent: string | null;
  }): Promise<Result<{ token: string; user: UserRow; session: SessionRow }>>;
  listPasskeys(input: { user: UserRow }): Promise<Result<PasskeySummary[]>>;
  deletePasskey(input: { user: UserRow; id: string }): Promise<Result<{ ok: true }>>;
  getSession(token: string): Promise<ResolvedSession | null>;
  signOut(token: string): Promise<void>;
}

export interface Auth {
  /** Serves the auth routes under `basePath`. Mount it for any request whose path starts with `basePath`. */
  handle(request: Request): Promise<Response>;
  /** The caller's session from the cookie or the bearer header, or null. */
  session(request: Request): Promise<ResolvedSession | null>;
  /**
   * The Set-Cookie value to send after `session(request)` when it moved the
   * expiry forward, else null. Send it on the response, or a browser drops
   * the cookie at its old Max-Age while the session row is still valid.
   * Null for a bearer request.
   */
  sessionCookie(request: Request, resolved: ResolvedSession): string | null;
  /** The same operations, in-process. */
  api: AuthApi;
  errors: typeof ERRORS;
}

export function createAuth(input: AuthConfig): Auth {
  const config = resolveConfig(input);
  const handle = createRouter(config, [
    ...sessionRoutes(config),
    ...magicLinkRoutes(config),
    ...socialRoutes(config),
    ...passkeyRoutes(config),
  ]);
  return {
    handle,
    async session(request) {
      const token = readSessionToken(config, request);
      return token ? resolveSession(config, token) : null;
    },
    sessionCookie: (request, resolved) => renewedSessionCookie(config, request, resolved),
    api: {
      requestMagicLink: (i) => requestMagicLink(config, i),
      verifyMagicLink: (i) => verifyMagicLink(config, i),
      startSocial: (i) => startSocial(config, i),
      completeSocial: (i) => completeSocial(config, i),
      passkeyRegistrationOptions: (i) => passkeyRegistrationOptions(config, i),
      verifyPasskeyRegistration: (i) => verifyPasskeyRegistration(config, i),
      passkeyAuthenticationOptions: (i) => passkeyAuthenticationOptions(config, i),
      verifyPasskeyAuthentication: (i) => verifyPasskeyAuthentication(config, i),
      listPasskeys: (i) => listPasskeys(config, i),
      deletePasskey: (i) => deletePasskey(config, i),
      getSession: (token) => resolveSession(config, token),
      signOut: (token) => destroySession(config, token),
    },
    errors: ERRORS,
  };
}
