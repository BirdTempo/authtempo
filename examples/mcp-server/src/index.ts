import type { MailPort } from "@authtempo/core";
import { requireMcpAuth } from "@authtempo/verify/mcp";
import { type Env, MCP_SCOPE, makeAuth, mcpResource } from "./auth.js";
import { mcpHandler } from "./mcp.js";

export type { Env } from "./auth.js";

/**
 * Your mail transport. Core calls `send` once per mail: a magic link, an
 * email code, a reset link. Replace the body with a call to your mail
 * provider. Until then a sign-in request answers 500, so a deploy with no
 * mail fails at once and not in silence.
 */
export const mail: MailPort = {
  async send() {
    throw new Error("my-app: no mail transport; replace mail.send in src/index.ts");
  },
};

/** What the app takes from outside. The test passes a mail port that keeps the mails. */
export interface Deps {
  mail: MailPort;
}

/** The app: the auth routes, the OAuth metadata, and the MCP route. */
export function createApp(env: Env, deps: Deps) {
  const auth = makeAuth(env, deps.mail);
  // The source is core's auth in this same Worker: it reads the token with
  // no fetch, so the Worker never fetches its own host.
  const mcp = requireMcpAuth(auth, mcpHandler, {
    resource: mcpResource(env),
    scopes: [MCP_SCOPE],
  });
  return {
    auth,
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      // The metadata documents live at the origin root, where an MCP client looks.
      if (pathname.startsWith("/.well-known/")) return auth.wellKnown(request);
      if (pathname.startsWith("/auth/")) return auth.handle(request);
      if (pathname === "/mcp") return mcp(request);
      return new Response("not found", { status: 404 });
    },
  };
}

// One app per isolate. The bindings stay the same for the life of the isolate.
let app: ReturnType<typeof createApp> | null = null;
const appOf = (env: Env) => (app ??= createApp(env, { mail }));

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return appOf(env).fetch(request);
  },
  // The cron trigger of wrangler.jsonc runs this. It deletes the rows that no flow can use.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(appOf(env).auth.api.sweepExpired());
  },
} satisfies ExportedHandler<Env>;
