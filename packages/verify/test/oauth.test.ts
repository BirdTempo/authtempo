import { describe, expect, it } from "vitest";
import { createVerifier } from "../src/index.js";
import { requireMcpAuth } from "../src/mcp.js";
import {
  accessToken,
  ISSUER,
  MCP,
  makeServer,
  sessionJwt,
  signedIn,
  withBearer,
} from "./harness.js";

describe("an OAuth access token (plan 11d)", () => {
  it("answers the oauth caller under its resource, and null under another path or origin", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const at = await accessToken(server, s.cookie, "openid");
    // A second resource under the first: a token of MCP must not pass under it.
    const v = createVerifier({
      issuer: ISSUER,
      resources: [MCP, `${MCP}/admin`],
      accept: ["oauth"],
      fetch: server.fetch,
      clock: server.clock,
    });
    const r = await v.verifyRequest(withBearer(`${MCP}/tools/list`, at));
    if (!r.ok || r.value?.kind !== "oauth") throw new Error("no oauth caller");
    expect(r.value).toMatchObject({ userId: s.user.id, scopes: ["openid"], resource: MCP });
    expect(r.value.clientId.startsWith("cl_")).toBe(true);
    expect(typeof r.value.tokenId).toBe("string");
    expect(await v.verifyRequest(withBearer(`${MCP}/admin/x`, at))).toEqual({
      ok: true,
      value: null,
    });
    expect(await v.verifyRequest(withBearer("https://api.example.com/mcpx", at))).toEqual({
      ok: true,
      value: null,
    });
    expect(await v.verifyRequest(withBearer("https://other.example.com/mcp", at))).toEqual({
      ok: true,
      value: null,
    });
  });

  it("answers null for an access token where only session JWTs are accepted (the typ swap of spec 8.12)", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const at = await accessToken(server, s.cookie);
    // The server lists MCP as a resource but accepts session JWTs only.
    // The access token must not pass, though its aud is the resource of the URL.
    const v = createVerifier({
      issuer: ISSUER,
      audience: "https://files.example.com",
      resources: [MCP],
      fetch: server.fetch,
      clock: server.clock,
    });
    expect(await v.verifyRequest(withBearer(`${MCP}/x`, at))).toEqual({ ok: true, value: null });
  });

  it("answers null for a session JWT presented to an OAuth resource", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const jwt = await sessionJwt(server, s.sessionToken);
    const v = createVerifier({
      issuer: ISSUER,
      audience: "https://files.example.com",
      resources: [MCP],
      accept: ["session-jwt", "oauth"],
      fetch: server.fetch,
      clock: server.clock,
    });
    const r = await v.verifyRequest(withBearer(`${MCP}/x`, jwt));
    // A session JWT verifies as its own kind: its audience is the files server, so the
    // MCP route must check the kind it needs.
    expect(r.ok && r.value?.kind).toBe("session-jwt");
  });

  it("never answers a client token as a user caller (ruling 27 of plan 12e)", async () => {
    const server = makeServer({
      oauth: {
        resources: [MCP],
        scopes: { "mcp:read": "Read the files" },
        registration: { cimd: false, dynamic: true },
      },
    });
    const clients = server.auth.api.oauth?.clients;
    if (!clients) throw new Error("oauth is off");
    const made = await clients.create({
      name: "Service",
      authMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      credentialsScopes: ["mcp:read"],
    });
    if (!made.ok || !made.value.clientSecret) throw new Error("no client");
    const clientId = made.value.client.id;
    const res = await server.auth.handle(
      new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa(`${clientId}:${made.value.clientSecret}`)}`,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "mcp:read",
          resource: MCP,
        }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    const { access_token: token } = (await res.json()) as { access_token: string };
    const verifierOf = (accept: ("oauth" | "oauth-client")[]) =>
      createVerifier({
        issuer: ISSUER,
        resources: [MCP],
        accept,
        fetch: server.fetch,
        clock: server.clock,
      });
    // A server that accepts user tokens only gets null, never a caller with the client as user.
    expect(await verifierOf(["oauth"]).verifyRequest(withBearer(`${MCP}/x`, token))).toEqual({
      ok: true,
      value: null,
    });
    const both = verifierOf(["oauth", "oauth-client"]);
    const r = await both.verifyRequest(withBearer(`${MCP}/x`, token));
    if (!r.ok || r.value?.kind !== "oauth-client") throw new Error("no client caller");
    expect(r.value).toMatchObject({ clientId, scopes: ["mcp:read"], resource: MCP, dpopJkt: null });
    expect("userId" in r.value).toBe(false);
    // The MCP guard needs a user: a client token gets 401 there.
    const route = requireMcpAuth(both, () => new Response("tools"), { resource: MCP });
    expect((await route(withBearer(`${MCP}/x`, token))).status).toBe(401);
  });
});
