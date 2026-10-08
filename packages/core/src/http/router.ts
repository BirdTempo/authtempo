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
  handler(ctx: RouteContext): Promise<Response>;
}

/**
 * Read the client IP from `cf-connecting-ip` only. On Cloudflare Workers the
 * platform sets this header and a caller cannot forge it. `x-forwarded-for`
 * is not read, because a caller sets it freely and could rotate it to bypass
 * a limit keyed on the ip. On another host the ip is null, and ip-keyed
 * limits do not apply until a trusted-proxy option exists.
 */
export function clientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip") || null;
}

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
    if (request.method === "POST") {
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
        ip: clientIp(request),
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
