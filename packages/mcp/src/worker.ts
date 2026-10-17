// The remote MCP server: a stateless Worker with the docs tools, the docs
// resources, and the prompts (plan 11e Task 16, spec 21). It has no
// authentication and stores no query and no IP. Each owned check runs before
// the SDK reads the body. The checks are the path, the method, the Host, the
// Origin, the body size, the token bucket, and the rate limit binding. This
// file imports no SDK module (protocol.ts is the one seam) and no Node module.
import { type AgentIndex, parseAgentIndex } from "./index-format.js";
import { LIMITS } from "./limits.js";
import { httpHandler } from "./protocol.js";
import {
  bindingLimiter,
  memoryLimiter,
  type RateLimitBinding,
  type RemoteLimiter,
  type TokenBucket,
  tokenBucket,
} from "./remote-limiter.js";
import { createServer } from "./server.js";
import type { SkillSet } from "./spec.js";

/** The static assets binding: the index and the skills that copy-index.mjs writes into dist/agent. */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/** The bindings and the variables of wrangler.jsonc. The Worker has no secret. */
export interface Env {
  ASSETS: AssetsBinding;
  /** The one host name that the Worker answers (DNS rebinding protection). */
  MCP_HOST: string;
  /**
   * The origins that may call, as a comma list. Empty: a request with an Origin
   * header gets 403. The Worker answers no CORS preflight and sends no CORS
   * header, so the list admits a caller outside CORS only, not a browser page.
   */
  MCP_ALLOWED_ORIGINS: string;
  MCP_LIMITER?: RateLimitBinding;
}

/** The parts that a test replaces. Each one has the production value by default. */
export interface WorkerDeps {
  /** The token bucket of this isolate. */
  bucket?: TokenBucket;
  /** The second limiter. By default the MCP_LIMITER binding, or none when the binding is absent. */
  limiter?: (env: Env) => RemoteLimiter;
  /** The MCP handler, which parses the body. By default the SDK through protocol.ts. */
  serve?: (request: Request, env: Env) => Promise<Response>;
}

/** The one path of the server. */
export const MCP_PATH = "/mcp";

/** A JSON-RPC error with no id, as the SDK answers a request that it refuses before the parse. */
function refuse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status, headers },
  );
}

/**
 * A Host header value: a DNS name, with an optional port of 1 to 5 digits.
 * Any other text, such as user info, a path, or an IPv6 literal, is no host here.
 */
const HOST_VALUE = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::([0-9]{1,5}))?$/;

/** The host name of a Host header, in lower case, or null when the header is absent or not of the grammar. */
function hostnameOf(host: string | null): string | null {
  const m = host === null ? null : HOST_VALUE.exec(host);
  if (m === null || m[1] === undefined) return null;
  if (m[2] !== undefined && Number(m[2]) > 65_535) return null;
  return m[1].toLowerCase();
}

/** The allowed origins of the comma list. */
function originsOf(list: string): string[] {
  return list
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * The body, read to at most LIMITS.bodyBytes. It answers null when the body is
 * longer. The read stops at the first chunk past the limit. So a stream with no
 * content-length cannot fill the memory of the isolate.
 */
async function readCapped(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITS.bodyBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return body;
}

/** The skill set of skills.json: an array of { name, markdown }. */
function parseSkills(text: string): SkillSet {
  const value: unknown = JSON.parse(text);
  if (
    !Array.isArray(value) ||
    !value.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as { name?: unknown }).name === "string" &&
        typeof (s as { markdown?: unknown }).markdown === "string",
    )
  )
    throw new Error("skills.json is not a list of skills");
  return value as SkillSet;
}

/** One asset as text. The assets binding reads the path of the URL; the host is not used. */
async function assetText(env: Env, path: string): Promise<string> {
  const r = await env.ASSETS.fetch(new Request(`https://assets.invalid${path}`));
  if (!r.ok) throw new Error(`the asset ${path} answered ${r.status}`);
  return r.text();
}

/**
 * The SDK handler of the remote surface, made once per isolate from the
 * index and the skills of the assets. A failed load is not kept, so the next
 * request tries again.
 */
function sdkServe(): (request: Request, env: Env) => Promise<Response> {
  let handler: Promise<(request: Request) => Promise<Response>> | undefined;
  return async (request, env) => {
    handler ??= (async () => {
      const index: AgentIndex = parseAgentIndex(await assetText(env, "/index.json"));
      const skills = parseSkills(await assetText(env, "/skills.json"));
      // The Worker logs no request (spec 21 item 8). The SDK's error text of a
      // refused request can hold header and body values, so it goes nowhere.
      return httpHandler(() => createServer({ surface: "remote", index, skills }), {
        onerror: () => {},
      });
    })();
    let serve: (request: Request) => Promise<Response>;
    try {
      serve = await handler;
    } catch {
      handler = undefined;
      return refuse(503, "the docs index is not available");
    }
    return serve(request);
  };
}

/** A Worker with the given parts. The default export is one Worker per isolate. */
export function createWorker(deps: WorkerDeps = {}): {
  fetch(request: Request, env: Env): Promise<Response>;
} {
  const bucket = deps.bucket ?? tokenBucket(LIMITS, Date.now);
  const limiter =
    deps.limiter ??
    ((env: Env) =>
      env.MCP_LIMITER === undefined ? memoryLimiter(true) : bindingLimiter(env.MCP_LIMITER));
  const serve = deps.serve ?? sdkServe();
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname !== MCP_PATH) return refuse(404, "not found");
      // The server is stateless: no SSE stream (GET) and no session (DELETE).
      if (request.method !== "POST") return refuse(405, "method not allowed", { allow: "POST" });
      // DNS rebinding protection: the Host must be the server's own name.
      if (hostnameOf(request.headers.get("host")) !== env.MCP_HOST)
        return refuse(403, "the host is not allowed");
      // A browser sends Origin. A server-side client sends none, and passes.
      // The surface serves MCP clients, not browser pages: it sends no CORS
      // header. Browser access needs CORS and a preflight, a later row.
      const origin = request.headers.get("origin");
      if (origin !== null && !originsOf(env.MCP_ALLOWED_ORIGINS).includes(origin))
        return refuse(403, "the origin is not allowed");
      const declared = request.headers.get("content-length");
      if (declared !== null && Number(declared) > LIMITS.bodyBytes)
        return refuse(413, "the body is too large");
      const body = await readCapped(request);
      if (body === null) return refuse(413, "the body is too large");
      const ip = request.headers.get("cf-connecting-ip") ?? "";
      if (!bucket.take(ip) || !(await limiter(env).limit(ip)))
        return refuse(429, "too many calls", { "retry-after": "60" });
      return serve(
        new Request(request.url, { method: "POST", headers: request.headers, body }),
        env,
      );
    },
  };
}

export default createWorker();
