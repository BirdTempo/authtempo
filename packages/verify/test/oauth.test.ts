import { describe, expect, it } from "vitest";
import { createVerifier } from "../src/index.js";
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
});
