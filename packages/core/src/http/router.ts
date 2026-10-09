import type { ResolvedConfig } from "../config.js";
import { json } from "./json.js";

export interface RouteContext {
  request: Request;
  url: URL;
  config: ResolvedConfig;
  ip: string | null;
  now: Date;
}

export interface Route {
  method: "GET" | "POST";
  path: string;
  /**
   * Skip the Origin check on this POST. Only for a callback that a provider
   * posts cross-site, such as Apple's `response_mode=form_post`. The route
   * must bind the request to the browser another way; the social routes use
   * the binding cookie and the state row.
   */
  allowCrossSiteForm?: boolean;
  handler(ctx: RouteContext): Promise<Response>;
}

/**
 * The client IP comes from `config.clientIp`. On Workers the platform sets
 * `cf-connecting-ip`, and the default reads it. On any other host a caller
 * can set that header, so a deployment there must pass its own `clientIp`
 * that reads the trusted proxy header. A null IP counts against one shared
 * IP bucket in the magic link limit, which fails closed.
 */
function originTrusted(config: ResolvedConfig, origin: string): boolean {
  if (origin === config.baseURL) return true;
  return config.trustedOrigins.has(origin);
}

/**
 * Exact match on method and `basePath + route.path`. A POST whose Origin
 * header is present and not trusted gets 403 before any handler runs. A
 * POST with no Origin is a non-browser client and passes.
 */
export function createRouter(
  config: ResolvedConfig,
  routes: Route[],
): (request: Request) => Promise<Response> {
  const table = new Map(routes.map((r) => [`${r.method} ${config.basePath}${r.path}`, r]));
  return async (request) => {
    const url = new URL(request.url);
    const route = table.get(`${request.method} ${url.pathname}`);
    if (!route) return json({ error: "not_found" }, 404);
    if (request.method === "POST" && !route.allowCrossSiteForm) {
      const origin = request.headers.get("origin");
      if (origin !== null && !originTrusted(config, origin)) {
        return json({ error: "origin_not_trusted" }, 403);
      }
    }
    try {
      return await route.handler({
        request,
        url,
        config,
        ip: config.clientIp(request),
        now: config.clock.now(),
      });
    } catch (e) {
      console.error(
        "tempo-auth: unhandled error",
        route.method,
        route.path,
        e instanceof Error ? e.name : typeof e,
      );
      return json({ error: "internal" }, 500);
    }
  };
}
