import { describe, expect, it } from "vitest";
import {
  bearerChallenge,
  createVerifier,
  insufficientScopeResponse,
  unauthorizedResponse,
} from "../src/index.js";
import { ISSUER, MCP } from "./harness.js";

const METADATA =
  'resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"';

/**
 * The challenges of RFC 6750 section 3 with the resource metadata link of
 * RFC 9728. The MCP authorization revision 2026-07-28 (read 2026-10-14):
 * a 401 SHOULD carry `scope`; a 403 carries `error="insufficient_scope"`,
 * `scope`, and `resource_metadata`; `offline_access` SHOULD NOT be in a scope.
 */
describe("the Bearer challenge (plan 11d)", () => {
  const v = createVerifier({ issuer: ISSUER, resources: [MCP], accept: ["oauth"] });

  it("answers 401 with the resource metadata link and the scope that the route needs", async () => {
    const res = v.unauthorized({ resource: MCP, scope: "mcp:tools" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer ${METADATA}, scope="mcp:tools"`);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("names invalid_token in the 401 of a token that the server refused", async () => {
    const res = v.unauthorized({
      resource: MCP,
      scope: ["mcp:tools", "mcp:read"],
      invalidToken: true,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", ${METADATA}, scope="mcp:tools mcp:read"`,
    );
  });

  it("answers 403 insufficient_scope with every scope of the operation in one challenge", async () => {
    const res = v.insufficientScope({
      resource: MCP,
      scope: ["mcp:tools", "files:write"],
      description: "The tool writes files.",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="mcp:tools files:write", ${METADATA}, error_description="The tool writes files."`,
    );
    expect(await res.json()).toEqual({ error: "insufficient_scope" });
  });

  it("answers a plain Bearer challenge with no input, and the root form for a resource at the root", () => {
    expect(v.unauthorized().headers.get("www-authenticate")).toBe("Bearer");
    expect(
      unauthorizedResponse({ resource: "https://files.example.com" }).headers.get(
        "www-authenticate",
      ),
    ).toBe(
      'Bearer resource_metadata="https://files.example.com/.well-known/oauth-protected-resource"',
    );
  });

  it("works with no verifier: the standalone functions answer the same", () => {
    expect(
      insufficientScopeResponse({ resource: MCP, scope: "mcp:tools" }).headers.get(
        "www-authenticate",
      ),
    ).toBe(
      v.insufficientScope({ resource: MCP, scope: "mcp:tools" }).headers.get("www-authenticate"),
    );
    expect(bearerChallenge({ scope: "a b" })).toBe('Bearer scope="a b"');
  });

  it("refuses offline_access, a scope with a quote or a space inside a token, and an empty scope list", () => {
    expect(() => v.unauthorized({ scope: "offline_access" })).toThrow(/offline_access/);
    expect(() => v.unauthorized({ scope: ['a"b'] })).toThrow(/scope/);
    expect(() => v.insufficientScope({ scope: [] })).toThrow(/scope/);
    expect(() => v.insufficientScope({ scope: "x", description: 'say "hi"' })).toThrow(
      /description/,
    );
  });
});
