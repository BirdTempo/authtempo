import type { ResolvedConfig } from "../config.js";
import {
  type ResolvedSession,
  renewedSessionCookie,
  sessionFromRequest,
} from "../engine/sessions.js";
import { json } from "./json.js";

/**
 * The caller's session and the renewed cookie, or null (plan 12a). It
 * resolves sessions only, so a `tk_` bearer and a JWT bearer answer 401, as
 * the token routes and the TOTP routes do.
 */
export async function withSession(
  config: ResolvedConfig,
  request: Request,
): Promise<{ resolved: ResolvedSession; renewed: string | null } | null> {
  const resolved = await sessionFromRequest(config, request);
  if (!resolved) return null;
  return { resolved, renewed: renewedSessionCookie(config, request, resolved) };
}

/** The response with the renewed session cookie, when the read moved the expiry. */
export function sent(res: Response, renewed: string | null): Response {
  if (renewed) res.headers.append("set-cookie", renewed);
  return res;
}

export function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}
