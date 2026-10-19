import { CLIENT_IP_HEADER } from "./auth.js";
import { Gate } from "./gate.js";
import { Sandbox } from "./sandbox.js";

export { Gate, Sandbox };

const COOKIE = "__Host-demo_sandbox";
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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/assets/")) return env.ASSETS.fetch(request);

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
  },
} satisfies ExportedHandler<Cloudflare.Env>;
