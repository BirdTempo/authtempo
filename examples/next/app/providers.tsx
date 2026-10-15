"use client";
import { type Client, createClient } from "@authtempo/client";
import { AuthProvider, useSession } from "@authtempo/react";
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

/** The client and the session store for every page. Tests pass a client of their own. */
export function Providers({ children, client }: { children: ReactNode; client?: Client }) {
  return (
    <AuthProvider client={client ?? appClient()}>
      <SessionRenewal />
      {children}
    </AuthProvider>
  );
}
