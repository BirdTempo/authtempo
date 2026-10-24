// Type fixture (plan 11d2): the Solid Start entry against @solidjs/start 2.0.6.
// `typecheck` fails when Solid Start changes a shape that the entry fits today.
import type { Auth } from "@authtempo/core";
import { createMiddleware } from "@solidjs/start/middleware";
import type { APIEvent } from "@solidjs/start/server";
import { authOnRequest, authRouteHandlers, getSession } from "../src/start.js";

declare const auth: Auth;

// src/middleware.ts: `export default createMiddleware({ onRequest: [authOnRequest(…)] })`.
export default createMiddleware({ onRequest: [authOnRequest({ auth })] });

// An API route: the handlers take an APIEvent, and getSession reads its locals.
const handlers = authRouteHandlers(auth);
export const GET = (event: APIEvent) => handlers.GET(event);
export const email = (event: APIEvent): string | null | undefined => getSession(event)?.user.email;
// The field that the entry declares on App.RequestEventLocals.
export const field = (event: APIEvent) => event.locals.session;
