// The remote Worker on workerd (plan 11e Task 16). The tests hold the owned
// checks in front of the SDK, the remote surface on the wire, and the assets.
//
// The values of wrangler.jsonc are written out here: the host, the empty
// origin list, and the binding limit. The limits of src/limits.ts are written
// out too: 64 KiB and 120 calls a minute. So a change on either side fails a test.
//
// The request envelope of revision 2026-07-28 was read in
// @modelcontextprotocol/core 2.3.1 on 2026-10-17 (test/protocol-raw.test.ts).
// Over HTTP a modern request also carries the MCP-Protocol-Version and
// Mcp-Method headers, and Mcp-Name for a call by name. Source: SEP-2243, read in
// @modelcontextprotocol/server 2.3.1 dist/index.mjs (standardHeadersOf).
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../src/limits.js";
import { memoryLimiter, tokenBucket } from "../../src/remote-limiter.js";
import worker, { createWorker, type Env } from "../../src/worker.js";

/** The bindings of wrangler.jsonc and the one binding of vitest.pool.config.ts. */
const ENV = env as unknown as Env & { SITE_INDEX: string };

const HOST = "mcp.authtempo.com";

/** The tools of the remote surface, typed here: the test does not read the table it pins. */
const REMOTE_TOOLS = ["docs.read", "docs.search", "version"];
/** The local tools, which the remote surface never serves. */
const LOCAL_ONLY = ["scaffold", "migrate.plan", "migrate.run", "schema.migrate", "check"];

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "pool-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** Each test calls from its own IP, so the bucket and the binding of one test do not meet another. */
let ipCount = 0;
const nextIp = () => `203.0.113.${++ipCount}`;

interface Options {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  path?: string;
}

function request(o: Options = {}): Request {
  const method = o.method ?? "POST";
  return new Request(`https://${HOST}${o.path ?? "/mcp"}`, {
    method,
    headers: {
      host: HOST,
      "cf-connecting-ip": nextIp(),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...o.headers,
    },
    ...(method === "POST" || method === "PUT" ? { body: o.body ?? "{}" } : {}),
  });
}

/** A 2026-07-28 request, with the headers that the revision asks for. */
function modern(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  const name = typeof params.name === "string" ? { "mcp-name": params.name } : {};
  return request({
    headers: {
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...name,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
  });
}

/** A 2025-era request: no protocol header and no envelope. */
function legacy(method: string, params: Record<string, unknown> = {}, id = 1): Request {
  return request({ body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
}

/** The JSON-RPC message of an answer: a JSON body, or the last data line of a server-sent event. */
async function rpc(r: Response): Promise<Record<string, unknown>> {
  const text = await r.text();
  if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice("data:".length).trim());
    const last = data.at(-1);
    if (last === undefined) throw new Error(`no data line in the event stream: ${text}`);
    return JSON.parse(last) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function resultOf(m: Record<string, unknown>): Record<string, unknown> {
  if (m.error !== undefined) throw new Error(`the answer is an error: ${JSON.stringify(m.error)}`);
  return m.result as Record<string, unknown>;
}

/** A stand-in of the SDK handler: it answers 200 and counts its calls. */
function serveSpy() {
  return vi.fn(async (_r: Request, _e: Env) =>
    Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the remote Worker", () => {
  it("lists the remote tools only", async () => {
    const r = await worker.fetch(modern("tools/list"), ENV);
    expect(r.status).toBe(200);
    const { tools } = resultOf(await rpc(r)) as { tools: { name: string }[] };
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(REMOTE_TOOLS);
    for (const local of LOCAL_ONLY) expect(names).not.toContain(local);
  });

  it("answers an unknown tool for scaffold", async () => {
    const r = await worker.fetch(
      modern("tools/call", { name: "scaffold", arguments: { stack: "workers-d1", dir: "app" } }),
      ENV,
    );
    const m = await rpc(r);
    expect(m.result).toBeUndefined();
    expect(m.error).toMatchObject({ code: -32602 });
    expect(JSON.stringify(m.error)).toContain("scaffold");
  });

  it("answers 400 and -32020 to a header that does not match the body", async () => {
    const r = await worker.fetch(modern("tools/list", {}, { "mcp-method": "prompts/list" }), ENV);
    expect(r.status).toBe(400);
    expect((await rpc(r)).error).toMatchObject({ code: -32020 });
  });

  it("answers 405 to GET and DELETE", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const r = await worker.fetch(request({ method }), ENV);
      expect(r.status, method).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
  });

  it("answers 404 to another path", async () => {
    for (const path of ["/", "/mcp/", "/sse"]) {
      const r = await worker.fetch(request({ path }), ENV);
      expect(r.status, path).toBe(404);
    }
    // Through the assets router of wrangler.jsonc: the index is no public file of the host.
    for (const path of ["/index.json", "/skills.json"]) {
      const r = await SELF.fetch(`https://${HOST}${path}`, { headers: { host: HOST } });
      expect(r.status, path).toBe(404);
      expect(await r.text()).not.toContain('"pages"');
    }
  });

  it("answers 403 to a foreign Origin, and passes no Origin", async () => {
    const foreign = await worker.fetch(
      modern("tools/list", {}, { origin: "https://evil.example" }),
      ENV,
    );
    expect(foreign.status).toBe(403);
    const opaque = await worker.fetch(modern("tools/list", {}, { origin: "null" }), ENV);
    expect(opaque.status).toBe(403);
    const none = await worker.fetch(modern("tools/list"), ENV);
    expect(none.status).toBe(200);
    // An origin of the list passes; the list of wrangler.jsonc is empty.
    const listed = { ...ENV, MCP_ALLOWED_ORIGINS: "https://a.example, https://app.example" };
    const allowed = await worker.fetch(
      modern("tools/list", {}, { origin: "https://app.example" }),
      listed,
    );
    expect(allowed.status).toBe(200);
  });

  it("answers 403 to another Host", async () => {
    const refused = [
      "evil.example",
      "mcp.authtempo.com.evil.example",
      "",
      "x@mcp.authtempo.com",
      "mcp.authtempo.com/x",
      "mcp.authtempo.com?x",
      "mcp.authtempo.com:99999",
      "mcp.authtempo.com.",
    ];
    for (const host of refused) {
      const r = await worker.fetch(modern("tools/list", {}, { host }), ENV);
      expect(r.status, host).toBe(403);
    }
    for (const host of [`${HOST}:443`, "MCP.AUTHTEMPO.COM"]) {
      const r = await worker.fetch(modern("tools/list", {}, { host }), ENV);
      expect(r.status, host).toBe(200);
    }
  });

  it("answers 413 to a body of 65 KiB, before the parse", async () => {
    const serve = serveSpy();
    const w = createWorker({ serve, limiter: () => memoryLimiter(true) });
    const big = new Uint8Array(65 * 1024).fill(0x20);
    // A Request made in a script has no content-length header, so the test sets it.
    const withLength = request({
      body: big,
      headers: { "content-length": String(big.byteLength) },
    });
    expect(withLength.headers.get("content-length")).toBe("66560");
    const declared = await w.fetch(withLength, ENV);
    expect(declared.status).toBe(413);
    // The body of the declared case is not read: it is still unused after the answer.
    expect(withLength.bodyUsed).toBe(false);
    // A stream with no content-length: the read stops past 64 KiB.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 65; i++) c.enqueue(new Uint8Array(1024).fill(0x20));
        c.close();
      },
    });
    const streamed = request({ body: stream });
    expect(streamed.headers.get("content-length")).toBeNull();
    expect((await w.fetch(streamed, ENV)).status).toBe(413);
    expect(serve).not.toHaveBeenCalled();
    // A body of exactly 64 KiB reaches the handler.
    const edge = await w.fetch(request({ body: new Uint8Array(65_536).fill(0x20) }), ENV);
    expect(edge.status).toBe(200);
    expect(serve).toHaveBeenCalledTimes(1);
  });

  it("answers 429 to the 121st call in 60 s from one IP", async () => {
    const serve = serveSpy();
    const w = createWorker({
      serve,
      bucket: tokenBucket(LIMITS, () => 0),
      limiter: () => memoryLimiter(true),
    });
    const call = (ip: string) => w.fetch(request({ headers: { "cf-connecting-ip": ip } }), ENV);
    for (let i = 1; i <= 120; i++)
      expect((await call("198.51.100.7")).status, `call ${i}`).toBe(200);
    const refused = await call("198.51.100.7");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect((await call("198.51.100.8")).status).toBe(200);
    expect(serve).toHaveBeenCalledTimes(121);
  });

  it("answers 429 when the limiter refuses", async () => {
    const serve = serveSpy();
    const w = createWorker({ serve, limiter: () => memoryLimiter(false) });
    const r = await w.fetch(request(), ENV);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(serve).not.toHaveBeenCalled();
  });

  it("answers initialize at 2025-06-18", async () => {
    const r = await worker.fetch(
      legacy("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pool-test", version: "0.0.0" },
      }),
      ENV,
    );
    expect(r.status).toBe(200);
    const result = resultOf(await rpc(r));
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo).toMatchObject({ name: "authtempo" });
    // The remote instructions name no local tool.
    for (const local of LOCAL_ONLY) expect(String(result.instructions)).not.toContain(local);
  });

  it("reads the same index as the site build", async () => {
    const r = await ENV.ASSETS.fetch(new Request(`https://${HOST}/index.json`));
    expect(r.status).toBe(200);
    const assets = new Uint8Array(await r.arrayBuffer());
    expect(assets).toEqual(new TextEncoder().encode(ENV.SITE_INDEX));
  });

  it("logs nothing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const calls = [
      legacy("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pool-test", version: "0.0.0" },
      }),
      modern("tools/list"),
      modern("tools/call", { name: "docs.search", arguments: { query: "magic link" } }),
      modern("tools/call", { name: "docs.read", arguments: { path: "/docs/" } }),
      modern("tools/call", { name: "version", arguments: {} }),
      modern("resources/list"),
      modern("prompts/list"),
      modern("tools/call", { name: "scaffold", arguments: {} }),
    ];
    // Requests that the SDK refuses. Its error text names their values, so none may reach a log.
    const refused = [
      request({ body: "[]" }),
      modern(
        "tools/call",
        { name: "docs.search", arguments: { query: "x" } },
        { "mcp-name": "OTHER-NAME" },
      ),
      request({ body: JSON.stringify({ id: 1, method: "tools/list" }) }),
      request({ body: "42" }),
      request({
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    ];
    for (const c of calls) {
      const r = await worker.fetch(c, ENV);
      await r.text();
    }
    for (const c of refused) {
      const r = await worker.fetch(c, ENV);
      await r.text();
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  // Review I-5 of Task 5: the -32700 filter is in the stdio binary only. This pins the HTTP answer.
  it("answers a body that is not JSON with a parse error", async () => {
    const r = await worker.fetch(request({ body: "not json" }), ENV);
    expect(r.status).toBe(400);
    expect((await rpc(r)).error).toMatchObject({ code: -32700 });
  });

  // Review I-3 of Task 6: the server keeps no state, so a cursor must work in the next POST.
  it("pages resources/list over two stateless POSTs", async () => {
    const first = resultOf(await rpc(await worker.fetch(modern("resources/list"), ENV))) as {
      resources: { uri: string }[];
      nextCursor?: string;
    };
    expect(first.resources).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = resultOf(
      await rpc(await worker.fetch(modern("resources/list", { cursor: first.nextCursor }), ENV)),
    ) as { resources: { uri: string }[] };
    expect(second.resources.length).toBeGreaterThan(0);
    const uris = [...first.resources, ...second.resources].map((e) => e.uri);
    expect(new Set(uris).size).toBe(uris.length);
  });

  // queryChars, limit, and resourcePage are copies in LIMITS: tools.ts and resources.ts
  // enforce them. This test holds each copy to the value that the server answers.
  it("holds the copied keys of LIMITS to the limits on the wire", async () => {
    const { tools } = resultOf(await rpc(await worker.fetch(modern("tools/list"), ENV))) as {
      tools: {
        name: string;
        inputSchema: { properties: Record<string, Record<string, unknown>> };
      }[];
    };
    const search = tools.find((t) => t.name === "docs.search")?.inputSchema.properties ?? {};
    expect(search.query?.maxLength).toBe(LIMITS.queryChars);
    expect(search.limit?.maximum).toBe(LIMITS.limit);
    const page = resultOf(await rpc(await worker.fetch(modern("resources/list"), ENV))) as {
      resources: unknown[];
      nextCursor?: string;
    };
    // The index has more pages than one list page, so the first page is full.
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.resources).toHaveLength(LIMITS.resourcePage);
  });

  it("binds no storage: the env holds the assets, the vars, the limiter, and the test index", () => {
    // Spec 21 item 8 and ruling 34: the Worker stores no query and no IP.
    // The pool adds its own bindings, each with the __VITEST_POOL_WORKERS_ prefix.
    const own = Object.keys(env).filter((k) => !k.startsWith("__VITEST_POOL_WORKERS_"));
    expect(own.sort()).toEqual(
      ["ASSETS", "MCP_ALLOWED_ORIGINS", "MCP_HOST", "MCP_LIMITER", "SITE_INDEX"].sort(),
    );
  });

  it("answers 429 when the rate limit binding of wrangler.jsonc refuses", async () => {
    const serve = serveSpy();
    const w = createWorker({ serve });
    const call = () => w.fetch(request({ headers: { "cf-connecting-ip": "192.0.2.77" } }), ENV);
    for (let i = 1; i <= 60; i++) expect((await call()).status, `call ${i}`).toBe(200);
    expect((await call()).status).toBe(429);
    expect(serve).toHaveBeenCalledTimes(60);
  });
});
