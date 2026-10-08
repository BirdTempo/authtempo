import { type AuthConfig, resolveConfig } from "./config.js";
import {
  type MagicLinkRequest,
  type MagicLinkVerify,
  requestMagicLink,
  verifyMagicLink,
} from "./engine/magic-link.js";
import {
  destroySession,
  type ResolvedSession,
  readSessionToken,
  resolveSession,
} from "./engine/sessions.js";
import { ERRORS } from "./errors.js";
import { createRouter } from "./http/router.js";
import { magicLinkRoutes } from "./http/routes/magic-link.js";
import { sessionRoutes } from "./http/routes/sessions.js";
import type { Result } from "./result.js";
import type { UserRow } from "./schema.js";

export interface AuthApi {
  requestMagicLink(input: MagicLinkRequest): Promise<Result<{ sent: true }>>;
  verifyMagicLink(
    input: MagicLinkVerify,
  ): Promise<Result<{ token: string; next: string; user: UserRow }>>;
  getSession(token: string): Promise<ResolvedSession | null>;
  signOut(token: string): Promise<void>;
}

export interface Auth {
  /** Serves the auth routes under `basePath`. Mount it for any request whose path starts with `basePath`. */
  handle(request: Request): Promise<Response>;
  /** The caller's session from the cookie or the bearer header, or null. */
  session(request: Request): Promise<ResolvedSession | null>;
  /** The same operations, in-process. */
  api: AuthApi;
  errors: typeof ERRORS;
}

export function createAuth(input: AuthConfig): Auth {
  const config = resolveConfig(input);
  const handle = createRouter(config, [...sessionRoutes(config), ...magicLinkRoutes(config)]);
  return {
    handle,
    async session(request) {
      const token = readSessionToken(config, request);
      return token ? resolveSession(config, token) : null;
    },
    api: {
      requestMagicLink: (i) => requestMagicLink(config, i),
      verifyMagicLink: (i) => verifyMagicLink(config, i),
      getSession: (token) => resolveSession(config, token),
      signOut: (token) => destroySession(config, token),
    },
    errors: ERRORS,
  };
}
