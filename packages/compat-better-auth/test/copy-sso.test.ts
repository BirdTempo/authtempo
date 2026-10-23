import { describe, expect, it } from "vitest";
import { copyBetterAuthSso } from "../src/copy-sso.js";
import { organization } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { sso } from "../src/sso.js";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { copySsoSuite } from "./copy-sso-suite.js";
import { BETTER_AUTH_PG, BETTER_AUTH_SSO_PG, BETTER_AUTH_SSO_ROWS_PG } from "./fixtures.js";
import { freshBetterAuthSchema, migrateWithoutLock } from "./pg.js";
import { BASE, fakeDns, SECRET } from "./sso-helpers.js";

// Better Auth's own tables and rows on a fresh Postgres schema, then the compat migrations.
copySsoSuite("Postgres", async () => {
  const pg = await freshBetterAuthSchema(
    `${BETTER_AUTH_PG}\n${BETTER_AUTH_SSO_PG}\n${BETTER_AUTH_SSO_ROWS_PG}`,
  );
  const names = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }).names;
  await migrateWithoutLock(pg.sql, names);
  return {
    // Postgres has no statement counter: the D1 suite measures the budget.
    fresh: () => ({
      database: betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }),
      statements: () => null,
    }),
    close: () => pg.close(),
  };
});

const EMAIL_NAMEID = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
/**
 * The SAML provider of the fixture once more, as Better Auth writes it with
 * `identifierFormat` set to the email address format (ruling 65 Q4).
 */
const DELTA = `insert into "ssoProvider" ("id", "issuer", "oidcConfig", "samlConfig", "userId", "providerId", "organizationId", "domain", "domainVerified")
  select 'delta-row', "issuer", null,
    replace("samlConfig", '"mapping":', '"identifierFormat":"${EMAIL_NAMEID}","mapping":'),
    "userId", 'delta-saml', "organizationId", 'delta.example', false
  from "ssoProvider" where "providerId" = 'gamma-saml';`;

describe("copyBetterAuthSso of another NameID format (review m2)", () => {
  it("skips the provider with its reason and never changes its format", async () => {
    const pg = await freshBetterAuthSchema(
      `${BETTER_AUTH_PG}\n${BETTER_AUTH_SSO_PG}\n${BETTER_AUTH_SSO_ROWS_PG}\n${DELTA}`,
    );
    try {
      const database = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
      await migrateWithoutLock(pg.sql, database.names);
      const source = await pg.sql`select "samlConfig" from "ssoProvider" where "id" = 'delta-row'`;
      expect(String(source[0]?.samlConfig)).toContain(EMAIL_NAMEID);
      const auth = betterAuth({
        baseURL: BASE,
        secret: SECRET,
        database,
        authtempo: { ssoDns: [fakeDns("a", new Map()).port] },
        emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
        emailVerification: { sendVerificationEmail: async () => {} },
        plugins: [
          organization({ sendInvitationEmail: async () => {} }),
          sso({ domainVerification: { enabled: true } }),
        ],
      });
      const skipped: { id: string; reason: string }[] = [];
      let after: string | null = null;
      for (let i = 0; i < 40; i++) {
        const r = await copyBetterAuthSso(auth, { after });
        skipped.push(...r.skipped);
        after = r.next;
        if (after === null) break;
      }
      expect(after).toBeNull();
      expect(skipped.filter((s) => s.id === "delta-row")).toEqual([
        {
          id: "delta-row",
          reason:
            "samlConfig.identifierFormat: core asks for the NameID format urn:oasis:names:tc:SAML:2.0:nameid-format:persistent only",
        },
      ]);
      // The other SAML provider of the fixture copies; no connection takes the other format.
      const labels = (await database.storage.findMany("ssoConnection", [])).map((c) => c.label);
      expect(labels).toContain("gamma-saml");
      expect(labels).not.toContain("delta-saml");
    } finally {
      await pg.close();
    }
  });
});
