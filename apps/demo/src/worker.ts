import { CLIENT_IP_HEADER } from "./auth.js";
import { Gate } from "./gate.js";
import { PAGE_HEADERS } from "./html.js";
import { Sandbox } from "./sandbox.js";

export { Gate, Sandbox };

const COOKIE = "__Host-demo_sandbox";
/** The answer of /reset clears the sandbox cookie with these attributes. */
const CLEAR_COOKIE = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
/** The folders of the build that the assets binding serves (copy-assets.mjs writes them). */
const ASSET_PREFIXES = ["/assets/", "/fonts/"];
/** A sandbox id is 16 random bytes in lower-case hex, so a guess needs 128 bits. */
const ID_RE = /^[0-9a-f]{32}$/;
/** Each candidate costs one exists() call, so a request with many values costs at most this many. */
const MAX_IDS = 4;

/**
 * Each value of the sandbox cookie that has the id form, in header order, at
 * most MAX_IDS. A browser sends one cookie of a __Host- name per host. A
 * request can still hold more, so each value is a candidate (ruling 32).
 */
function cookieIds(request: Request): string[] {
  const ids: string[] = [];
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (name === COOKIE && ID_RE.test(value)) ids.push(value);
  }
  return ids.slice(0, MAX_IDS);
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The request for the sandbox. The Worker deletes any incoming
 * x-demo-client-ip and sets it from cf-connecting-ip, which only Cloudflare
 * sets. So a visitor cannot choose the IP that core's limits count.
 */
function forSandbox(request: Request): Request {
  const forwarded = new Request(request);
  forwarded.headers.delete(CLIENT_IP_HEADER);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) forwarded.headers.set(CLIENT_IP_HEADER, ip);
  return forwarded;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The page headers on one answer of the script. A header that the answer
 * already has stays, so a page of core keeps its own policy.
 */
function withPageHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(PAGE_HEADERS))
    if (!out.headers.has(name)) out.headers.set(name, value);
  return out;
}

/**
 * Start again: deletes each live sandbox that the cookie names, clears the
 * cookie, and goes to the home page. No Origin check: the cookie is
 * SameSite=Lax, so a post from another site carries no sandbox id.
 */
async function reset(request: Request, env: Cloudflare.Env, origin: string): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  for (const id of cookieIds(request)) {
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(id));
    if (await stub.exists()) await stub.destroy();
  }
  return new Response(null, {
    status: 303,
    headers: { location: `${origin}/`, "set-cookie": CLEAR_COOKIE },
  });
}

/** Every answer of the script but the assets. */
async function route(request: Request, env: Cloudflare.Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/reset") return reset(request, env, url.origin);

  // The first value that names a live sandbox takes the request.
  for (const id of cookieIds(request)) {
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(id));
    if (await stub.exists()) return stub.handle(forSandbox(request));
  }
  // A form post never lands in a new sandbox by surprise.
  if (request.method !== "GET" && request.method !== "HEAD")
    return json(409, { error: "sandbox_reset" });

  const gate = env.GATE.get(env.GATE.idFromName("gate"));
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const admitted = await gate.admit(ip, Date.now());
  if (!admitted.ok) return json(429, { error: "demo_limit", limit: admitted.limit });

  const fresh = newId();
  await env.SANDBOX.get(env.SANDBOX.idFromName(fresh)).create();
  return new Response(null, {
    status: 303,
    headers: {
      location: `${url.origin}${url.pathname}${url.search}`,
      "set-cookie": `${COOKIE}=${fresh}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    // A file of the build. public/_headers sets the headers of these answers.
    if (ASSET_PREFIXES.some((p) => pathname.startsWith(p))) return env.ASSETS.fetch(request);
    return withPageHeaders(await route(request, env));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
