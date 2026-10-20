import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";
import { freshSchema } from "./db.js";

describe("schema version 11 on Postgres (plan 12e)", () => {
  it("reads a version 10 client and token row with every default", async () => {
    const { a, close } = await freshSchema();
    try {
      const i0011 = MIGRATIONS.findIndex((m) => m.name === "0011_schema_v11");
      expect(i0011).toBe(10);
      for (const m of MIGRATIONS.slice(0, i0011)) await a.unsafe(m.sql);
      // A writer of version 10 names only the version 10 columns.
      await a.unsafe(
        `INSERT INTO ta_oauth_client (id, created_at, updated_at, kind, name, redirect_uris, last_seen_at) VALUES ('cl_10', now(), now(), 'registered', NULL, '["https://app.example.com/cb"]'::jsonb, now())`,
      );
      await a.unsafe(
        `INSERT INTO ta_oauth_token (id, created_at, updated_at, token_hash, family_id, user_id, client_id, scopes, resource, expires_at, used_at) VALUES ('t10', now(), now(), 'h10', 'f10', 'u10', 'cl_10', '["offline_access"]'::jsonb, 'https://api.example.com/mcp', now() + interval '1 day', NULL)`,
      );
      await a.unsafe(MIGRATIONS[i0011]?.sql ?? "");
      const version = await a.unsafe<{ value: string }[]>(
        "SELECT value FROM ta_meta WHERE key = 'schema_version'",
      );
      expect(version[0]?.value).toBe("11");
      // The adapter reads only a database of the current version: apply the later migrations first (0012 since plan 12f, 0013 since plan 12k).
      for (const m of MIGRATIONS.slice(i0011 + 1)) await a.unsafe(m.sql);
      const db = createPostgresAdapter(a);
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
    } finally {
      await close();
    }
  });
});
