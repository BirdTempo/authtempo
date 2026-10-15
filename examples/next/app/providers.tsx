"use client";
import {
  type Client,
  createClient,
  ERRORS,
  type ErrorCode,
  errorText,
  type OAuthClientCode,
} from "@authtempo/client";
import { type AuthErrorCode, AuthProvider, useAuthError, useSession } from "@authtempo/react";
import type { ReactNode } from "react";

// The API is this app's own origin: core is mounted under /auth.
let browserClient: Client | null = null;
function appClient(): Client {
  browserClient ??= createClient({
    baseURL: typeof location === "undefined" ? "http://localhost:3000" : location.origin,
  });
  return browserClient;
}

/**
 * Subscribes to the session store on every page, so the browser reads
 * GET /auth/session. That read is the one that slides the session and sends
 * the renewed cookie: the server components read with no write, so without
 * this read a session ends at its first expiry.
 */
function SessionRenewal(): null {
  useSession();
  return null;
}

/**
 * The text of a redirect error. A code of core's table takes the core text;
 * any other code is an OAuth code or `unexpected`, which the OAuth table answers.
 */
function redirectText(code: NonNullable<AuthErrorCode>): string {
  return Object.hasOwn(ERRORS, code)
    ? errorText(code as ErrorCode)
    : errorText(code as OAuthClientCode, "oauth");
}

/**
 * Core sends every browser flow failure to the app's URL with
 * `?auth_error=<code>`, such as a magic link that is spent. The read sits here,
 * so the text shows on whichever page the failure lands.
 */
function AuthErrorNotice(): ReactNode {
  const code = useAuthError();
  return code ? <p role="alert">{redirectText(code)}</p> : null;
}

/** The client and the session store for every page. Tests pass a client of their own. */
export function Providers({ children, client }: { children: ReactNode; client?: Client }) {
  return (
    <AuthProvider client={client ?? appClient()}>
      <SessionRenewal />
      <AuthErrorNotice />
      {children}
    </AuthProvider>
  );
}
