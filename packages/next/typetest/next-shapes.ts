// Type fixture (plan 11d): each export of @authtempo/next against the types of
// next@16.4.0, the version of the peer range. `typecheck` fails when Next changes
// a shape that the binding fits today.
import type { Auth } from "@authtempo/core";
import { headers } from "next/headers";
import type { NextProxy, NextRequest } from "next/server";
import { authProxy, authRouteHandlers, authSession } from "../src/index.js";

declare const auth: Auth;

// proxy.ts: `export const proxy = authProxy(…)` must be a NextProxy.
export const proxy: NextProxy = authProxy({ protect: () => true, signInPath: "/sign-in" });

// app/auth/[...path]/route.ts: each handler takes the NextRequest that Next passes.
const handlers = authRouteHandlers(auth);
export const GET: (request: NextRequest) => Promise<Response> = handlers.GET;
export const POST: (request: NextRequest) => Promise<Response> = handlers.POST;

// A server component: headers() answers the ReadonlyHeaders that authSession takes.
export async function page(): Promise<string | null> {
  const s = await authSession(auth, await headers());
  return s?.user.email ?? null;
}
