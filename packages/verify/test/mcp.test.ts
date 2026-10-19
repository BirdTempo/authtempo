import { createMemoryAdapter, type StorageAdapter } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { bearerChallenge, createVerifier } from "../src/index.js";
import { type McpCaller, McpScopeError, type McpSource, requireMcpAuth } from "../src/mcp.js";
import {
  accessToken,
  BASE,
  dpopProof,
  FILES,
  ISSUER,
  MCP,
  makeServer,
  type Server,
  sessionJwt,
  signedIn,
  withBearer,
} from "./harness.js";

/** The second resource of the same issuer. */
const FILES_API = `${BASE}/files`;
const SCOPES = { "mcp:tools": "Use the tools", "mcp:read": "Read the files" };

/**
 * A storage that the test can take down, as a database outage does.
 * Each call to a method of the memory adapter throws while it is down.
 */
function failingStorage() {
  const inner = createMemoryAdapter();
  let down = false;
  const storage = new Proxy(inner, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (down) throw new Error("the database does not answer");
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as StorageAdapter;
  return {
    storage,
    down() {
      down = true;
    },
  };
}

/** A core with two resources of one issuer and the scopes of the MCP tools. */
function setup() {
  const db = failingStorage();
  const server = makeServer({
    storage: db.storage,
    oauth: {
      resources: [MCP, FILES_API],
      scopes: SCOPES,
      registration: { cimd: false, dynamic: true },
    },
  });
  return { server, down: db.down, storage: db.storage };
}

/**
 * A real API token of core, minted by its token API for the signed-in person.
 * `storage` is the storage that core uses: `setup` gives core its own, not the harness's.
 */
async function apiToken(server: Server, storage: StorageAdapter, userId: string): Promise<string> {
  const user = await storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
  if (!user) throw new Error("no user");
  const t = await server.auth.api.tokens.create({ user, name: "ci" });
  if (!t.ok) throw new Error(t.code);
  return t.value.token;
}

type SourceName = "verifier" | "core";

/** The source of the wrapper: a Verifier that accepts every kind, or core's auth itself. */
function sourceOf(name: SourceName, server: Server): McpSource {
  if (name === "core") return server.auth;
  return createVerifier({
    issuer: ISSUER,
    audience: FILES,
    resources: [MCP, FILES_API],
    accept: ["session-jwt", "oauth", "api-token", "session-token"],
    fetch: server.fetch,
    clock: server.clock,
  });
}

/** A handler that records its caller and answers a fixed response. */
function recorder() {
  const seen: McpCaller[] = [];
  const answer = new Response("tools", { status: 200 });
  return {
    seen,
    answer,
    handler: (_request: Request, caller: McpCaller) => {
      seen.push(caller);
      return answer;
    },
  };
}

describe("requireMcpAuth construction (plan 11e)", () => {
  const source = { caller: async () => null };
  const handler = () => new Response();

  it("refuses a resource that is not https, or http off 127.0.0.1 and localhost", () => {
    for (const resource of [
      "not a url",
      "http://api.example.com/mcp",
      "https://api.example.com/mcp?x=1",
      "https://api.example.com/mcp#a",
      "https://user:pw@api.example.com/mcp",
      "ftp://api.example.com/mcp",
      "http://127.0.0.2/mcp",
      // Core's rule refuses any "#", an empty fragment too.
      "https://api.example.com/mcp#",
    ])
      expect(() => requireMcpAuth(source, handler, { resource }), resource).toThrow(/resource/);
  });

  it("accepts https, and http on 127.0.0.1 and localhost", () => {
    for (const resource of [MCP, "http://127.0.0.1:8787/mcp", "http://localhost:8787/mcp"])
      expect(typeof requireMcpAuth(source, handler, { resource })).toBe("function");
  });

  it("refuses a scope that the challenge refuses", () => {
    for (const scopes of [["offline_access"], ['mcp"tools'], ["mcp tools"], []])
      expect(() => requireMcpAuth(source, handler, { resource: MCP, scopes })).toThrow();
    expect(() =>
      requireMcpAuth(source, handler, { resource: MCP, challengeScopes: ["offline_access"] }),
    ).toThrow(/offline_access/);
    expect(() => new McpScopeError(["offline_access"])).toThrow(/offline_access/);
  });
});

describe.each(["verifier", "core"] as const)("requireMcpAuth with the %s source", (name) => {
  it("answers 401 with no bearer, and calls no handler", async () => {
    const { server } = setup();
    const s = await signedIn(server);
    const r = recorder();
    const route = requireMcpAuth(sourceOf(name, server), r.handler, {
      resource: MCP,
      scopes: ["mcp:tools"],
      challengeScopes: ["mcp:tools", "mcp:read"],
    });
    // A session cookie is no credential of an MCP route: core's caller would read it.
    for (const request of [
      new Request(MCP),
      new Request(MCP, { headers: { cookie: s.cookie } }),
      new Request(MCP, { headers: { authorization: "Basic dXNlcjpwdw==" } }),
    ]) {
      const res = await route(request);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        bearerChallenge({ resource: MCP, scope: ["mcp:tools", "mcp:read"] }),
      );
    }
    expect(r.seen).toEqual([]);
  });

  it("answers 401 invalid_token for a bearer that is not an access token", async () => {
    const { server, storage } = setup();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const tk = await apiToken(server, storage, s.user.id);
    expect(tk.startsWith("tk_")).toBe(true);
    const r = recorder();
    const route = requireMcpAuth(sourceOf(name, server), r.handler, {
      resource: MCP,
      scopes: ["mcp:tools"],
    });
    for (const bearer of [s.sessionToken, jwt, tk, "not-a-token"]) {
      const res = await route(withBearer(MCP, bearer));
      expect(res.status, bearer).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        bearerChallenge({ resource: MCP, scope: ["mcp:tools"], error: "invalid_token" }),
      );
    }
    expect(r.seen).toEqual([]);
  });

  it("refuses a token for another resource", async () => {
    const { server } = setup();
    const s = await signedIn(server);
    // The harness mints for MCP. The route guards the second resource of the same issuer.
    const at = await accessToken(server, s.cookie, "openid mcp:tools");
    const r = recorder();
    const route = requireMcpAuth(sourceOf(name, server), r.handler, {
      resource: FILES_API,
      scopes: ["mcp:tools"],
    });
    const res = await route(withBearer(`${MCP}/tools`, at));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      bearerChallenge({ resource: FILES_API, scope: ["mcp:tools"], error: "invalid_token" }),
    );
    expect(r.seen).toEqual([]);
  });

  it("refuses a token for another resource at this route", async () => {
    const { server } = setup();
    const s = await signedIn(server);
    // Review focus 6: a token of the files resource, sent to the MCP route.
    const at = await accessToken(server, s.cookie, "openid mcp:tools", FILES_API);
    const r = recorder();
    const route = requireMcpAuth(sourceOf(name, server), r.handler, {
      resource: MCP,
      scopes: ["mcp:tools"],
    });
    const res = await route(withBearer(`${MCP}/tools`, at));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      bearerChallenge({ resource: MCP, scope: ["mcp:tools"], error: "invalid_token" }),
    );
    expect(r.seen).toEqual([]);
  });

  it("refuses a DPoP-bound token as a bearer (RFC 9449 section 7.2, plan 12e Task 9)", async () => {
    const { server } = setup();
    const s = await signedIn(server);
    const proof = { dpop: await dpopProof(server) };
    const at = await accessToken(server, s.cookie, "openid mcp:tools", MCP, proof);
    const r = recorder();
    const route = requireMcpAuth(sourceOf(name, server), r.handler, {
      resource: MCP,
      scopes: ["mcp:tools"],
    });
    const res = await route(withBearer(`${MCP}/tools`, at));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      bearerChallenge({ resource: MCP, scope: ["mcp:tools"], error: "invalid_token" }),
    );
    expect(r.seen).toEqual([]);
  });

  it("lets the bearer decide when the request also holds a session cookie", async () => {
    const { server } = setup();
    const s = await signedIn(server);
    const at = await accessToken(server, s.cookie, "openid mcp:tools");
    const r = recorder();
    const route = requireMcpAuth(sourceOf(name, server), r.handler, {
      resource: MCP,
      scopes: ["mcp:tools"],
    });
    // A client in a page of the auth app's origin sends the cookie with each fetch.
    const request = new Request(`${MCP}/tools`, {
      headers: { authorization: `Bearer ${at}`, cookie: s.cookie },
    });
    expect(await route(request)).toBe(r.answer);
    expect(r.seen.map((c) => c.userId)).toEqual([s.user.id]);
  });

  it("answers 403 that names every scope of the operation", async () => {
    const { server } = setup();
    const s = await signedIn(server);
    const at = await accessToken(server, s.cookie, "openid mcp:tools");
    const r = recorder();
    const route = requireMcpAuth(sourceOf(name, server), r.handler, {
      resource: MCP,
      scopes: ["mcp:tools", "mcp:read"],
    });
    const res = await route(withBearer(MCP, at));
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(
      bearerChallenge({
        resource: MCP,
        scope: ["mcp:tools", "mcp:read"],
        error: "insufficient_scope",
      }),
    );
    expect(r.seen).toEqual([]);
  });

  it("answers 503 with no body detail when the source fails, never 401", async () => {
    const { server, down } = setup();
    const s = await signedIn(server);
    const at = await accessToken(server, s.cookie, "openid mcp:tools");
    const r = recorder();
    const route = requireMcpAuth(sourceOf(name, server), r.handler, {
      resource: MCP,
      scopes: ["mcp:tools"],
    });
    // The verifier reads the key set: an outage of it is a failure, not a refusal.
    // Core reads its database: an outage makes its caller throw.
    if (name === "verifier") server.outage("/jwks");
    else down();
    const res = await route(withBearer(MCP, at));
    expect(res.status).toBe(503);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.text()).toBe("");
    expect(r.seen).toEqual([]);
  });

  it("answers 403 for a McpScopeError of the handler, and passes any other throw", async () => {
    const { server } = setup();
    const s = await signedIn(server);
    const at = await accessToken(server, s.cookie, "openid mcp:tools");
    const scoped = requireMcpAuth(
      sourceOf(name, server),
      () => {
        throw new McpScopeError(["mcp:read"]);
      },
      { resource: MCP, scopes: ["mcp:tools"] },
    );
    const res = await scoped(withBearer(MCP, at));
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(
      bearerChallenge({ resource: MCP, scope: ["mcp:read"], error: "insufficient_scope" }),
    );
    const fault = new TypeError("a fault of the tool");
    const failing = requireMcpAuth(
      sourceOf(name, server),
      async () => {
        throw fault;
      },
      { resource: MCP, scopes: ["mcp:tools"] },
    );
    await expect(failing(withBearer(MCP, at))).rejects.toBe(fault);
  });

  it("passes the caller to the handler and answers its response unchanged", async () => {
    const { server } = setup();
    const s = await signedIn(server);
    const at = await accessToken(server, s.cookie, "openid mcp:tools");
    const r = recorder();
    const route = requireMcpAuth(sourceOf(name, server), r.handler, {
      resource: MCP,
      scopes: ["mcp:tools"],
    });
    const res = await route(withBearer(`${MCP}/tools`, at));
    expect(res).toBe(r.answer);
    expect(r.seen).toHaveLength(1);
    const caller = r.seen[0];
    if (!caller) throw new Error("no caller");
    // Core's caller has `user`; the wrapper maps `user.id` to `userId`, as the verifier does.
    expect(Object.keys(caller).sort()).toEqual(
      ["clientId", "expiresAt", "resource", "scopes", "tokenId", "userId"].sort(),
    );
    expect(caller).toMatchObject({
      userId: s.user.id,
      scopes: ["openid", "mcp:tools"],
      resource: MCP,
    });
    expect(caller.clientId.startsWith("cl_")).toBe(true);
    expect(caller.tokenId).not.toBe("");
    expect(caller.expiresAt).toBeInstanceOf(Date);
    // A route with no scopes needs none.
    const open = recorder();
    const bare = requireMcpAuth(sourceOf(name, server), open.handler, { resource: MCP });
    expect(await bare(withBearer(MCP, at))).toBe(open.answer);
  });
});
