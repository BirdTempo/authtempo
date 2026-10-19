import { describe, expect, it } from "vitest";
import { createVerifier, type IntrospectOptions } from "../src/index.js";
import {
  accessToken,
  BASE,
  claimsOf,
  ISSUER,
  MCP,
  makeServer,
  type Server,
  signedIn,
  withBearer,
} from "./harness.js";

/**
 * Token introspection from the verifier (plan 12e Task 10, RFC 7662 read
 * 2026-10-20). The introspection client is a real confidential client of
 * `api.oauth.clients`, and core answers each call.
 */

const TOOLS = `${MCP}/tools`;
const INTROSPECT = "/auth/oauth/introspect";

function serverWithScopes() {
  return makeServer({
    oauth: {
      resources: [MCP],
      scopes: { "mcp:read": "Read the files" },
      registration: { cimd: false, dynamic: true },
    },
  });
}

/** A confidential client with `introspect: true`, made through the in-process client API. */
async function resourceServer(server: Server): Promise<IntrospectOptions> {
  const clients = server.auth.api.oauth?.clients;
  if (!clients) throw new Error("oauth is off");
  const made = await clients.create({
    name: "Resource server",
    authMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    credentialsScopes: ["mcp:read"],
    introspect: true,
  });
  if (!made.ok) throw new Error(made.error);
  const secret = made.value.clientSecret;
  if (!secret) throw new Error("create answered no secret");
  return { clientId: made.value.client.id, clientSecret: secret };
}

function verifierOf(
  server: Server,
  introspect: IntrospectOptions,
  fetch: typeof globalThis.fetch = server.fetch,
) {
  return createVerifier({
    issuer: ISSUER,
    resources: [MCP],
    accept: ["oauth"],
    fetch,
    clock: server.clock,
    introspect,
  });
}

describe("introspection in the verifier (plan 12e Task 10)", () => {
  it("asks the introspection endpoint once per access token when introspect is set, and answers null for active false", async () => {
    const server = serverWithScopes();
    const rs = await resourceServer(server);
    const s = await signedIn(server);
    const token = await accessToken(server, s.cookie);
    const v = verifierOf(server, rs);
    const r = await v.verifyRequest(withBearer(TOOLS, token));
    expect(r.ok && r.value?.kind === "oauth" && r.value.userId).toBe(s.user.id);
    expect(server.count(INTROSPECT)).toBe(1);
    // A token that fails the offline check costs no call.
    expect(await v.verifyRequest(withBearer(`${BASE}/other`, token))).toEqual({
      ok: true,
      value: null,
    });
    // The edit always changes the signature: a signature can end in "AA" already.
    const changed = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    expect(await v.verifyRequest(withBearer(TOOLS, changed))).toEqual({
      ok: true,
      value: null,
    });
    expect(server.count(INTROSPECT)).toBe(1);
    // A grant revoke: core answers active false, and the verifier answers null.
    server.clock.advance(5_000);
    const revoked = await server.auth.handle(
      new Request(`${ISSUER}/oauth/grants/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: s.cookie },
        body: JSON.stringify({ clientId: claimsOf(token).client_id }),
      }),
    );
    expect(revoked.status).toBe(200);
    expect(await v.verifyRequest(withBearer(TOOLS, token))).toEqual({ ok: true, value: null });
    expect(server.count(INTROSPECT)).toBe(2);
    // The same token passes the offline check alone: introspection made the difference.
    const offline = createVerifier({
      issuer: ISSUER,
      resources: [MCP],
      accept: ["oauth"],
      fetch: server.fetch,
      clock: server.clock,
    });
    const r2 = await offline.verifyRequest(withBearer(TOOLS, token));
    expect(r2.ok && r2.value?.kind).toBe("oauth");
  });

  it("answers network, never null, when the endpoint does not answer", async () => {
    const server = serverWithScopes();
    const rs = await resourceServer(server);
    const s = await signedIn(server);
    const token = await accessToken(server, s.cookie);
    const v = verifierOf(server, rs);
    server.outage("/oauth/introspect");
    expect(await v.verifyRequest(withBearer(TOOLS, token))).toEqual({
      ok: false,
      code: "network",
      status: 0,
    });
    expect(server.count(INTROSPECT)).toBe(1);
    // A 200 whose body has no boolean active is no answer of core.
    const odd = verifierOf(server, rs, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === INTROSPECT) return Response.json({ active: "yes" });
      return server.auth.handle(request);
    }) as typeof globalThis.fetch);
    expect(await odd.verifyRequest(withBearer(TOOLS, token))).toEqual({
      ok: false,
      code: "unexpected",
      status: 200,
    });
  });

  it("authenticates with client_secret_basic", async () => {
    const server = serverWithScopes();
    const rs = await resourceServer(server);
    const s = await signedIn(server);
    const token = await accessToken(server, s.cookie);
    const v = verifierOf(server, rs);
    const r = await v.verifyRequest(withBearer(TOOLS, token));
    expect(r.ok && r.value?.kind).toBe("oauth");
    // The second fetch is the introspection call; the first read the key set.
    const init = server.inits[1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe("POST");
    expect(headers.get("authorization")).toBe(`Basic ${btoa(`${rs.clientId}:${rs.clientSecret}`)}`);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(String(init?.body)).toBe(`token=${token}&token_type_hint=access_token`);
    expect(init?.redirect).toBe("manual");
    // A wrong secret: core answers 401, and the verifier answers unexpected, never null.
    const wrong = verifierOf(server, {
      clientId: rs.clientId,
      clientSecret: `${rs.clientSecret}x`,
    });
    expect(await wrong.verifyRequest(withBearer(TOOLS, token))).toEqual({
      ok: false,
      code: "unexpected",
      status: 401,
    });
    // RFC 6749 section 2.3.1: each part is form-encoded before the base64.
    const seen: string[] = [];
    const encoded = verifierOf(
      server,
      { clientId: "https://rs.example.com/a b", clientSecret: "p:w+%" },
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname !== INTROSPECT) return server.auth.handle(request);
        seen.push(request.headers.get("authorization") ?? "");
        return Response.json({ active: true });
      }) as typeof globalThis.fetch,
    );
    const e = await encoded.verifyRequest(withBearer(TOOLS, token));
    expect(e.ok && e.value?.kind).toBe("oauth");
    expect(seen).toEqual([
      "Basic aHR0cHMlM0ElMkYlMkZycy5leGFtcGxlLmNvbSUyRmErYjpwJTNBdyUyQiUyNQ==",
    ]);
    // A wrong option throws at construction.
    expect(() => verifierOf(server, { clientId: "", clientSecret: "x" })).toThrow(/introspect/);
    expect(() => verifierOf(server, { clientId: "x", clientSecret: "" })).toThrow(/introspect/);
  });
});
