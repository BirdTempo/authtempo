import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

describe("schema version 11 on D1 (plan 12e)", () => {
  it("moves the version to 11", async () => {
    // env.DB holds every migration (0012 since plan 12f), so read the version that 0011 itself writes.
    const m0011 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0011_"));
    expect(
      m0011?.queries.some((q) =>
        q.includes("UPDATE ta_meta SET value = '11' WHERE key = 'schema_version'"),
      ),
    ).toBe(true);
  });

  it("reads a version 10 client and token row with every default", async () => {
    // The rows go in between the files, as a Worker of version 10 writes them, so 0011 must fill them.
    const i0011 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0011_"));
    expect(i0011).toBe(10);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0011));
    await env.STAGED.prepare(
      `INSERT INTO ta_oauth_client (id, created_at, updated_at, kind, name, redirect_uris, last_seen_at) VALUES ('cl_10', 1, 1, 'registered', NULL, '["https://app.example.com/cb"]', 1)`,
    ).run();
    await env.STAGED.prepare(
      `INSERT INTO ta_oauth_token (id, created_at, updated_at, token_hash, family_id, user_id, client_id, scopes, resource, expires_at, used_at) VALUES ('t10', 1, 1, 'h10', 'f10', 'u10', 'cl_10', '["offline_access"]', 'https://api.example.com/mcp', 4102444800000, NULL)`,
    ).run();
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS);
    const db = createD1Adapter(env.STAGED);
    const client = await db.findOne("oauthClient", [{ field: "id", op: "eq", value: "cl_10" }]);
    expect(client).toMatchObject({
      authMethod: "none",
      secretHash: null,
      secretExpiresAt: null,
      previousSecretHash: null,
      previousSecretUntil: null,
      jwks: null,
      jwksUri: null,
      grantTypes: ["authorization_code", "refresh_token"],
      credentialsScopes: [],
      introspect: false,
      postLogoutRedirectUris: [],
      backchannelLogoutUri: null,
      backchannelLogoutSessionRequired: false,
      subjectType: "public",
      dpopBound: false,
    });
    const token = await db.findOne("oauthToken", [{ field: "id", op: "eq", value: "t10" }]);
    expect(token).toMatchObject({ parentId: null, dpopJkt: null });
  });
});
