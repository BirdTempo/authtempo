import { CLIENT_IP_HEADER } from "./auth.js";
import { DEMO_LIMITS } from "./facts.js";
import { IsolateCount } from "./flood.js";
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
/**
 * Each candidate costs one exists() call. A browser sends one cookie of a
 * __Host- name per host, so two values cover a stale value before the live
 * one (ruling 32). With the gate admit and the create, one request then makes
 * at most four Durable Object calls (final review m7).
 */
const MAX_IDS = 2;

/**
 * The first limit, before any Durable Object call. It lives in the isolate on
 * purpose: a count in a Durable Object would cost the call that it saves.
 * At most 10,000 keys stay in memory.
 */
const FIRST = new IsolateCount(DEMO_LIMITS.requestsPerIpPerMinute, 10_000);

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
function forSandbox(request: Request, ip: string): Request {
  const forwarded = new Request(request);
  forwarded.headers.delete(CLIENT_IP_HEADER);
  forwarded.headers.set(CLIENT_IP_HEADER, ip);
  return forwarded;
}

/**
 * The request with its body read into memory, or null when the body is
 * above bodyBytes. A content-length above the cap stops the request before
 * any read. A body with no content-length stops at byte bodyBytes + 1, so
 * the Worker never holds more than the cap and one chunk.
 */
async function capped(request: Request): Promise<Request | null> {
  const cap = DEMO_LIMITS.bodyBytes;
  if (Number(request.headers.get("content-length") ?? "0") > cap) return null;
  if (request.body === null) return request;
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.byteLength;
  }
  return new Request(request, { body });
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
 * cookie, and goes to the home page. Two guards keep another site from a
 * reset (ruling 36). First, a post with Sec-Fetch-Site cross-site or
 * same-site gets 403. A browser sends that header also under no-referrer.
 * Second, the answer clears the cookie only when the request named one.
 * Chrome sends no Lax cookie on a cross-site post, but it stores a cookie
 * of the answer, so an unconditional clear resets the visitor.
 */
async function reset(request: Request, env: Cloudflare.Env, origin: string): Promise<Response> {
  if (request.method !== "POST") {
    // RFC 9110 15.5.6: a 405 answer names the methods of the resource in Allow.
    const refused = json(405, { error: "method_not_allowed" });
    refused.headers.set("allow", "POST");
    return refused;
  }
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return json(403, { error: "cross_site" });
  const ids = cookieIds(request);
  const home = { location: `${origin}/` };
  if (ids.length === 0) return new Response(null, { status: 303, headers: home });
  for (const id of ids) {
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(id));
    if (await stub.exists()) await stub.destroy();
  }
  return new Response(null, { status: 303, headers: { ...home, "set-cookie": CLEAR_COOKIE } });
}

/** Every answer of the script but the assets, for the visitor at `ip`. */
async function route(request: Request, env: Cloudflare.Env, ip: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/reset") return reset(request, env, url.origin);

  // The first value that names a live sandbox takes the request.
  for (const id of cookieIds(request)) {
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(id));
    if (await stub.exists()) return stub.handle(forSandbox(request, ip));
  }
  // A form post never lands in a new sandbox by surprise. Only GET admits: a
  // link preview or a monitor sends HEAD, and each HEAD would spend one of the
  // sandboxes of its address (final review Low 2).
  if (request.method !== "GET") return json(409, { error: "sandbox_reset" });

  const gate = env.GATE.get(env.GATE.idFromName("gate"));
  const admitted = await gate.admit(ip, Date.now());
  if (!admitted.ok) return json(429, { error: "demo_limit", limit: admitted.limit });

  const fresh = newId();
  await env.SANDBOX.get(env.SANDBOX.idFromName(fresh)).create();
  return new Response(null, {
    status: 303,
    headers: {
      location: `${url.origin}${url.pathname}${url.search}`,
      "set-cookie": `${COOKIE}=${fresh}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${DEMO_LIMITS.sandboxLifeMs / 1000}`,
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    // A file of the build. public/_headers sets the headers of these answers.
    if (ASSET_PREFIXES.some((p) => pathname.startsWith(p))) return env.ASSETS.fetch(request);
    // On Cloudflare the header is always set. A missing one means that
    // another path reached the script, so no IP can be counted.
    const ip = request.headers.get("cf-connecting-ip");
    if (ip === null || ip === "") return withPageHeaders(json(400, { error: "no_client_ip" }));
    if (!FIRST.take(ip, Date.now()))
      return withPageHeaders(json(429, { error: "demo_limit", limit: "requestsPerIpPerMinute" }));
    const bounded = await capped(request);
    if (bounded === null) return withPageHeaders(json(413, { error: "body_too_large" }));
    return withPageHeaders(await route(bounded, env, ip));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
