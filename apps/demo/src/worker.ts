import { Gate } from "./gate.js";
import { Sandbox } from "./sandbox.js";

export { Gate, Sandbox };

const COOKIE = "__Host-demo_sandbox";
/** A sandbox id is 16 random bytes in lower-case hex, so a guess needs 128 bits. */
const ID_RE = /^[0-9a-f]{32}$/;

function cookieId(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== COOKIE) continue;
    const value = rest.join("=");
    return ID_RE.test(value) ? value : null;
  }
  return null;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

    const id = cookieId(request);
    if (id !== null) {
      const stub = env.SANDBOX.get(env.SANDBOX.idFromName(id));
      if (await stub.exists()) return stub.handle(request);
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
