import { describe, expect, it } from "vitest";
import { createVerifier } from "../src/index.js";
import { type McpCaller, requireMcpAuth } from "../src/mcp.js";
import {
  accessToken,
  claimsOf,
  ISSUER,
  MCP,
  makeServer,
  type Server,
  signedIn,
  withBearer,
} from "./harness.js";

/**
 * The subject of an access token at each source (ruling 34 of plan 12e). A
 * pairwise token keeps its `ps_` subject. The verifier, both sources of
 * `requireMcpAuth`, and the `subject` of `auth.caller` answer it. The `user`
 * of `auth.caller` stays the user. Each token comes from a real core instance.
 */

const TOOLS = `${MCP}/tools`;
/** A redirect URI on a host, so the client has a sector. A loopback URI is no sector. */
const RP = "https://rp.example.org/callback";

/** The userId of each source for `token`, and the user and subject of `auth.caller`. */
async function answers(server: Server, token: string) {
  const verifier = createVerifier({
    issuer: ISSUER,
    resources: [MCP],
    accept: ["oauth"],
    fetch: server.fetch,
    clock: server.clock,
  });
  const r = await verifier.verifyRequest(withBearer(TOOLS, token));
  if (!r.ok || r.value?.kind !== "oauth") throw new Error("no oauth caller");
  const seen: string[] = [];
  const handler = (_request: Request, caller: McpCaller) => {
    seen.push(caller.userId);
    return new Response("tools");
  };
  for (const source of [verifier, server.auth]) {
    const res = await requireMcpAuth(source, handler, { resource: MCP })(withBearer(TOOLS, token));
    expect(res.status).toBe(200);
  }
  const core = await server.auth.caller(withBearer(TOOLS, token));
  if (core?.kind !== "oauth") throw new Error("no core caller");
  return {
    verifier: r.value.userId,
    mcpVerifier: seen[0],
    mcpCore: seen[1],
    coreUser: core.user.id,
    coreSubject: core.subject,
  };
}

describe("the token subject at each source (ruling 34 of plan 12e)", () => {
  it("answers the pairwise subject at every source, and auth.caller keeps the user", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const token = await accessToken(
      server,
      s.cookie,
      "openid",
      MCP,
      {},
      {
        redirect: RP,
        metadata: { subject_type: "pairwise" },
      },
    );
    const sub = String(claimsOf(token).sub);
    expect(sub).toMatch(/^ps_/);
    expect(await answers(server, token)).toEqual({
      verifier: sub,
      mcpVerifier: sub,
      mcpCore: sub,
      coreUser: s.user.id,
      coreSubject: sub,
    });
  });

  it("answers the user id at every source for a public client", async () => {
    const server = makeServer();
    const s = await signedIn(server);
    const token = await accessToken(server, s.cookie, "openid", MCP, {}, { redirect: RP });
    expect(claimsOf(token).sub).toBe(s.user.id);
    expect(await answers(server, token)).toEqual({
      verifier: s.user.id,
      mcpVerifier: s.user.id,
      mcpCore: s.user.id,
      coreUser: s.user.id,
      coreSubject: s.user.id,
    });
  });
});
