import type { Auth } from "@authtempo/core";
import { compatApiError } from "../errors.js";
import { sessionAnswerOf } from "./api.js";
import type { Mapped } from "./map-options.js";
import { readToken } from "./shapes.js";

/**
 * Better Auth 1.7.2's message of the POST with the option off
 * (@better-auth/core dist/error/codes.mjs:50, read 2026-10-17).
 */
const DEFER_REQUIRED = "POST method requires deferSessionRefresh to be enabled in session config";

/**
 * Better Auth 1.7.2's `/get-session` (dist/api/routes/session.mjs, read
 * 2026-10-17), served by `auth.handler` in Better Auth's shape (plan 12a).
 * A GET forwards to core's `GET /session`, and a POST to core's
 * `POST /session/refresh`. So core's router applies its rules, and core's
 * `readModeOf` decides the write. Null for any other request.
 */
export async function getSessionRoute(
  auth: Auth,
  mapped: Mapped,
  request: Request,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== `${mapped.basePath}/get-session`) return null;
  const method = request.method;
  // Any other method, an OPTIONS preflight too, goes to core's router.
  if (method !== "GET" && method !== "POST") return null;
  // Better Auth refuses the POST with the option off (session.mjs:37). The option is core's key.
  if (method === "POST" && mapped.config.session?.deferRefresh !== true) {
    const e = compatApiError("METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED", DEFER_REQUIRED);
    return Response.json(e.body, { status: e.statusCode });
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const to = method === "GET" ? "/session" : "/session/refresh";
  const res = await auth.handle(
    new Request(`${mapped.origin}${mapped.basePath}${to}`, {
      method,
      headers,
      ...(method === "POST" ? { body: "{}" } : {}),
    }),
  );
  if (res.status !== 200 && res.status !== 401) return res;
  // Core's headers stay: the renewed cookie, the clear of a dead cookie, and CORS.
  const out = new Headers(res.headers);
  out.delete("content-length");
  // Better Auth answers null with 200 for no session (session.mjs:142 to :151).
  if (res.status === 401) return Response.json(null, { status: 200, headers: out });
  // The row in Better Auth's shape. This read has the request's method, so
  // readModeOf gives it the mode of core's read. A GET under the option
  // writes nothing and sets needsRefresh. A POST finds no refresh due.
  const s = await auth.session(request);
  if (!s) return Response.json(null, { status: 200, headers: out });
  return Response.json(await sessionAnswerOf(auth, mapped, s, readToken(request.headers) ?? ""), {
    status: 200,
    headers: out,
  });
}
