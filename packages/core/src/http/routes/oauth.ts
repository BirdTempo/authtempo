import type { ResolvedConfig } from "../../config.js";
import { registerClient } from "../../engine/oauth-clients.js";
import type { OAuthResult } from "../../engine/oauth-result.js";
import { json } from "../json.js";
import type { Route } from "../router.js";

/** An OAuth answer: the value with `status`, or `{ error }` with the status of `OAUTH_ERRORS`. No cache keeps either. */
export function oauthJson<T>(r: OAuthResult<T>, status = 200): Response {
  return r.ok ? json(r.value, status) : json({ error: r.error }, r.status);
}

/** A JSON object body, or null. */
async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The provider routes (plan 9g, spec 8.13). None exists while `oauth` is
 * off. The router's Origin rule applies: a native client sends no Origin
 * and passes; a browser on an origin that is not trusted gets 403.
 */
export function oauthRoutes(config: ResolvedConfig): Route[] {
  const oauth = config.oauth;
  if (!oauth) return [];
  const routes: Route[] = [];
  if (oauth.dynamic)
    routes.push({
      method: "POST",
      path: "/oauth/register",
      async handler(ctx) {
        const metadata = await readObject(ctx.request);
        if (!metadata) return json({ error: "invalid_client_metadata" }, 400);
        return oauthJson(await registerClient(config, { metadata, ip: ctx.ip }), 201);
      },
    });
  return routes;
}
