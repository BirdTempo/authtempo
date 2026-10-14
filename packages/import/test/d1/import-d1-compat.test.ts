import { applyD1Migrations, createScheduledController, env } from "cloudflare:test";
import {
  betterAuth,
  betterAuthPasswordHash,
  betterAuthSchemaStorage,
} from "@authtempo/compat-better-auth";
import { createPbkdf2PasswordHash } from "@authtempo/core";
import { createLegacyPasswordHash } from "@authtempo/legacy-hashes";
import { VECTORS } from "@authtempo/legacy-hashes/testing";
import { describe, expect, it, vi } from "vitest";
import betterAuthSqlite from "../../../compat-better-auth/test/fixtures/better-auth-1.7.2.sqlite.sql?raw";
import worker from "../../worker/src/index.js";
import { runImport, targetOf } from "../../worker/src/run.js";
import { SUPABASE_FIXTURE_CREATED } from "../fixtures/supabase-counts.js";
import identities from "../fixtures/supabase-identities.csv?raw";
import users from "../fixtures/supabase-users.csv?raw";

/**
 * The statements of the recorded schema: comment lines dropped, split on ";".
 * The file holds no ";" in a literal. The same rule as statementsOf in
 * packages/compat-better-auth/test/d1/sql.ts.
 */
const statements = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

// Better Auth 1.7.2's own SQLite schema as recorded, with its seven foreign keys, then the shipped compat migrations.
await env.DB.batch(statements(betterAuthSqlite).map((s) => env.DB.prepare(s)));
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

const count = async (table: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM "${table}"`).first<number>("n")) ?? -1;
const NONE = { user: 0, identity: 0, password: 0, passkey: 0, organization: 0, member: 0 };
const supabase = { bundle: { provider: "supabase", files: { users, identities } } };

describe("the D1 Worker's TARGET (plan 9b2)", () => {
  it("reads core or compat, defaults to core, and refuses any other value", () => {
    expect(targetOf(undefined)).toBe("core");
    expect(targetOf("core")).toBe("core");
    expect(targetOf("compat")).toBe("compat");
    for (const bad of ["", "Compat", "better-auth", "postgres"])
      expect(() => targetOf(bad)).toThrow(
        `authtempo import: TARGET is core or compat, not ${JSON.stringify(bad)}; nothing was written`,
      );
  });

  it("refuses an unknown TARGET at start, before any read, and logs no report", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // An input that no read accepts shows that the TARGET check runs before the input is read.
    vi.resetModules();
    vi.doMock("authtempo-import-input", () => ({ default: { bundle: 5 } }));
    const { default: fresh } = await import("../../worker/src/index.js");
    try {
      await expect(
        fresh.scheduled(createScheduledController(), {
          DB: env.DB,
          LOCAL_IMPORT: "1",
          TARGET: "better-auth",
        }),
      ).rejects.toThrow('TARGET is core or compat, not "better-auth"; nothing was written');
      expect(log).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("authtempo-import-input");
      log.mockRestore();
    }
    expect(await count("user")).toBe(0);
  });

  it("refuses with schema_mismatch and writes nothing while the compat migration is missing", async () => {
    // Only the compat marker goes: core's own check passes on schema_version alone.
    await env.DB.prepare("DELETE FROM ta_meta WHERE key = 'compat_better_auth'").run();
    try {
      await expect(
        runImport(env.DB, { ...supabase, options: { formats: ["bcrypt"] } }, "compat"),
      ).rejects.toMatchObject({ code: "schema_mismatch" });
    } finally {
      await env.DB.prepare(
        "INSERT INTO ta_meta (key, value) VALUES ('compat_better_auth', '6')",
      ).run();
    }
    expect(await count("user")).toBe(0);
  });

  it("logs the target beside the report line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(createScheduledController(), {
        DB: env.DB,
        LOCAL_IMPORT: "1",
        TARGET: "compat",
      });
      const line = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(line).toMatchObject({ target: "compat", status: 0 });
      expect(line.authtempoImport).toMatchObject({ dryRun: true, created: NONE });
    } finally {
      log.mockRestore();
    }
  });

  it("imports a Supabase export into the Better Auth tables, and the compat handler signs in", async () => {
    const options = { formats: ["bcrypt"] };
    const first = await runImport(env.DB, { ...supabase, options }, "compat");
    expect(first.created).toEqual({ ...NONE, ...SUPABASE_FIXTURE_CREATED });
    // Seven users; nine identities and two passwords, all of them account rows.
    expect([await count("user"), await count("account")]).toEqual([7, 11]);
    expect(
      await env.DB.prepare(
        `SELECT "issuer" FROM "account" WHERE "providerId" = 'google' ORDER BY "accountId" LIMIT 1`,
      ).first("issuer"),
    ).toBe("https://accounts.google.com");
    const auth = betterAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: ["https://app.example.com"],
      database: betterAuthSchemaStorage({ dialect: "d1", db: env.DB }),
      emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
      emailVerification: { sendVerificationEmail: async () => {} },
      authtempo: {
        passwordHash: createLegacyPasswordHash({
          formats: ["bcrypt"],
          next: betterAuthPasswordHash({ pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }) }),
        }),
      },
    });
    // Ada's row holds the Go bcrypt test vector, whose password is "allmine".
    // The import wrote it as it is, so the sign-in below runs the legacy
    // check and the rehash, not a PBKDF2 match.
    const adaPassword = () =>
      env.DB.prepare(
        `SELECT a."password" FROM "account" a JOIN "user" u ON u."id" = a."userId" WHERE a."providerId" = 'credential' AND u."email" = 'ada@example.com'`,
      ).first("password");
    expect(await adaPassword()).toMatch(/^\$2a\$10\$/);
    const signedIn = await auth.api.signInEmail({
      body: { email: "ada@example.com", password: VECTORS.bcrypt2a.password },
    });
    expect(signedIn.token).toMatch(/^ts_/);
    expect(await adaPassword()).toMatch(/^pbkdf2-sha256\$1000\$/);
    const second = await runImport(env.DB, { ...supabase, options }, "compat");
    expect(second.created).toEqual(NONE);
    expect(second.exists.user).toBe(7);
  });
});
