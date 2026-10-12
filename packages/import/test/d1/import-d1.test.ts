import { applyD1Migrations, createScheduledController, env } from "cloudflare:test";
import { createD1Adapter } from "@tempo-auth/adapter-d1";
import { LEGACY_FORMATS } from "@tempo-auth/legacy-hashes";
import { FIREBASE } from "@tempo-auth/legacy-hashes/testing";
import { describe, expect, it, vi } from "vitest";
import { type ImportBundle, sourceOf } from "../../src/sources.js";
import worker from "../../worker/src/index.js";
import { type D1Bundle, runImport } from "../../worker/src/run.js";
import identities from "../fixtures/supabase-identities.csv?raw";
import users from "../fixtures/supabase-users.csv?raw";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The tests share one database (the pool gives each file its own storage), so
// each one compares the rows after a run with the rows before it.

/** Core's tables after the five migrations in packages/adapter-d1/migrations. */
const TABLES = 12;

/**
 * Every row of every core table, read with raw SQL and not through the
 * adapter, so a write the adapter does not read back still shows.
 */
async function everyRow(): Promise<Record<string, string[]>> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta\\_%' ESCAPE '\\' ORDER BY name",
  ).all<{ name: string }>();
  expect(results).toHaveLength(TABLES);
  const rows: Record<string, string[]> = {};
  for (const { name } of results) {
    const { results: all } = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
    rows[name] = all.map((r) => JSON.stringify(r)).sort();
  }
  return rows;
}

const bundle: D1Bundle["bundle"] = {
  provider: "supabase",
  files: { users, identities },
  firebase: { ...FIREBASE },
};

const NONE = { user: 0, identity: 0, password: 0, passkey: 0, organization: 0, member: 0 };

describe("the D1 import (worker/src/run.ts on core's D1 adapter)", () => {
  it("runs the Worker's default input: a dry run of an empty export, one report line, no write", async () => {
    const start = await everyRow();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.scheduled(createScheduledController(), { ...env, LOCAL_IMPORT: "1" });
      expect(log).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(line.tempoAuthImport).toMatchObject({ dryRun: true, created: NONE });
      // The CLI's exit status beside the report: 0, because the sample refuses nothing.
      expect(line.status).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(await everyRow()).toEqual(start);
  });

  it("logs status 1 beside the report when a person must look (a refused hash)", async () => {
    // The sample input gives status 0, so this test swaps the input module for
    // a dry run that refuses every hash (formats: []). A fixed status in the
    // log line fails here.
    const start = await everyRow();
    vi.resetModules();
    vi.doMock("tempo-auth-import-input", () => ({
      default: { bundle, options: { dryRun: true, formats: [] } },
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const fresh = (await import("../../worker/src/index.js")).default;
      await fresh.scheduled(createScheduledController(), { ...env, LOCAL_IMPORT: "1" });
      const line = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(line.tempoAuthImport.refusedHashes.length).toBeGreaterThan(0);
      expect(line.status).toBe(1);
    } finally {
      log.mockRestore();
      vi.doUnmock("tempo-auth-import-input");
      vi.resetModules();
    }
    expect(await everyRow()).toEqual(start);
  });

  it("refuses to run without LOCAL_IMPORT=1 from wrangler dev --var, and writes nothing", async () => {
    const start = await everyRow();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const LOCAL_IMPORT of [undefined, "0", "true"])
        await expect(
          worker.scheduled(createScheduledController(), {
            DB: env.DB,
            ...(LOCAL_IMPORT !== undefined ? { LOCAL_IMPORT } : {}),
          }),
        ).rejects.toThrow(
          "tempo-auth import: the D1 Worker runs only under wrangler dev with --var LOCAL_IMPORT:1 (worker/README.md); nothing was written",
        );
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
    expect(await everyRow()).toEqual(start);
  });

  it("reads every record before the first write: a Clerk bundle with bad organizations writes nothing", async () => {
    const start = await everyRow();
    // One valid Clerk user, then an organizations input that is not an array.
    // The reader yields the user before it reads the organizations.
    const csv = `id,first_name,last_name,username,primary_email_address,primary_phone_number,verified_email_addresses,unverified_email_addresses,verified_phone_numbers,unverified_phone_numbers,totp_secret,password_digest,password_hasher
user_2a,Kim,Lee,,kim@example.com,,kim@example.com,,,,,$2b$10$U4C0ZY8OG8y41F9LusfKyu3HRMBL0rCZcKBVsXhgr.n8Ou6FPhzO2,bcrypt
`;
    const clerkUsers = JSON.stringify([
      {
        id: "user_2a",
        primary_email_address_id: "idn_1",
        email_addresses: [
          { id: "idn_1", email_address: "kim@example.com", verification: { status: "verified" } },
        ],
        external_accounts: [],
        password_enabled: true,
        created_at: 1700000000000,
      },
    ]);
    const clerk = (organizations: string): D1Bundle => ({
      bundle: { provider: "clerk", files: { csv, users: clerkUsers, organizations } },
      options: { formats: LEGACY_FORMATS },
    });
    await expect(runImport(env.DB, clerk(JSON.stringify({ data: [] })))).rejects.toThrow(
      "tempo-auth import: the Clerk organizations input is not a JSON array",
    );
    expect(await everyRow()).toEqual(start);
    // The same bundle with valid organizations writes the user: the refusal
    // above came from the organizations, not from the user.
    const dry = await runImport(env.DB, {
      ...clerk("[]"),
      options: { dryRun: true, formats: LEGACY_FORMATS },
    });
    expect(dry.created.user).toBe(1);
    expect(await everyRow()).toEqual(start);
  });

  it("refuses a bundle of the wrong shape, naming the field, and writes nothing", async () => {
    const start = await everyRow();
    const cases: [unknown, string][] = [
      [null, "the D1 input field (root) is not an object"],
      [{ bundle }, "the D1 input field options is not an object"],
      [
        { bundle, options: { dryRun: "false", formats: LEGACY_FORMATS } },
        "the D1 input field options.dryRun is not true or false",
      ],
      [
        { bundle: [], options: { formats: LEGACY_FORMATS } },
        "the bundle field bundle is not an object",
      ],
      [
        { bundle: { ...bundle, provider: "okta" }, options: { formats: LEGACY_FORMATS } },
        "the bundle field provider is not one of supabase, clerk, auth0, firebase, authjs, cognito",
      ],
      [
        { bundle: { ...bundle, files: null }, options: { formats: LEGACY_FORMATS } },
        "the bundle field files is not an object",
      ],
      [
        {
          bundle: { ...bundle, files: { users: 7, identities } },
          options: { formats: LEGACY_FORMATS },
        },
        "the bundle field files.users is not text",
      ],
      [
        {
          bundle: { ...bundle, files: { users, identities, csv: "" } },
          options: { formats: LEGACY_FORMATS },
        },
        "the bundle field files.csv is not a supabase file",
      ],
      [
        {
          bundle: { provider: "supabase", files: { users } },
          options: { formats: LEGACY_FORMATS },
        },
        "the bundle field files.identities is missing; supabase needs it",
      ],
      [
        {
          bundle: { ...bundle, firebase: { signerKey: "k" } },
          options: { formats: LEGACY_FORMATS },
        },
        "the bundle field firebase.saltSeparator is not text",
      ],
      [
        {
          bundle: { ...bundle, firebase: { ...FIREBASE, rounds: "8" } },
          options: { formats: LEGACY_FORMATS },
        },
        "the bundle field firebase.rounds is not an integer",
      ],
      [
        { bundle: { ...bundle, samePasskeyRpId: "yes" }, options: { formats: LEGACY_FORMATS } },
        "the bundle field samePasskeyRpId is not true or false",
      ],
    ];
    for (const [input, message] of cases)
      await expect(runImport(env.DB, input)).rejects.toThrow(`tempo-auth import: ${message}`);
    // bundleOf refuses an unknown provider first; sourceOf refuses it too, for a caller that skips the check.
    expect(() => sourceOf({ provider: "okta", files: {} } as unknown as ImportBundle)).toThrow(
      "tempo-auth import: unknown provider okta",
    );
    expect(await everyRow()).toEqual(start);
  });

  it("checks every option value by type: a truthy string imports no Cognito marker", async () => {
    const start = await everyRow();
    const cognito = {
      provider: "cognito",
      files: {
        users: JSON.stringify({
          Users: [
            {
              Username: "c0ffee",
              Attributes: [
                { Name: "sub", Value: "sub-1" },
                { Name: "email", Value: "cara@example.com" },
                { Name: "email_verified", Value: "true" },
              ],
              Enabled: true,
              UserStatus: "CONFIRMED",
            },
          ],
        }),
      },
    };
    const cases: [unknown, string][] = [
      [{ formats: [], legacyVerify: "false" }, "options.legacyVerify is not true or false"],
      [{ formats: "bcrypt" }, "options.formats is not a list; the app's seam names it"],
      [{ formats: ["md5"] }, 'options.formats holds "md5", not a known format'],
      [{}, "options.formats is not a list; the app's seam names it"],
      [{ formats: [], onEmailTaken: "merge" }, "options.onEmailTaken is not skip or fail"],
      [{ formats: [], roleMap: { billing: 1 } }, "options.roleMap.billing is not text"],
      [{ formats: [], reservedSlugs: "help" }, "options.reservedSlugs is not a list of text"],
      [{ formats: [], platformSlug: 7 }, "options.platformSlug is not text"],
      [{ formats: [], repair: "true" }, "options.repair is not true or false"],
    ];
    for (const [options, message] of cases)
      await expect(runImport(env.DB, { bundle: cognito, options })).rejects.toThrow(
        `tempo-auth import: the D1 input field ${message}`,
      );
    // No row at all, so no marker row either.
    expect(await everyRow()).toEqual(start);
  });

  it("refuses a malformed bundle and writes nothing", async () => {
    const start = await everyRow();
    const noColumn = users.replace(",is_sso_user", "");
    await expect(
      runImport(env.DB, {
        bundle: { ...bundle, files: { users: noColumn, identities } },
        options: { formats: LEGACY_FORMATS },
      }),
    ).rejects.toThrow("tempo-auth import: the Supabase users file has no is_sso_user column");
    expect(await everyRow()).toEqual(start);
  });

  it("writes nothing on a dry run, imports, and changes zero rows on the second run", async () => {
    const db = createD1Adapter(env.DB);
    const empty = await everyRow();
    expect(empty.ta_user).toEqual([]);
    const dry = await runImport(env.DB, {
      bundle,
      options: { dryRun: true, formats: LEGACY_FORMATS },
    });
    expect(await everyRow()).toEqual(empty);
    const first = await runImport(env.DB, { bundle, options: { formats: LEGACY_FORMATS } });
    // The fixture as in test/readers/supabase.test.ts: seven users, three
    // passwords (two bcrypt, one Firebase scrypt), nine identities.
    expect(first.created).toEqual({ ...NONE, user: 7, identity: 9, password: 3 });
    expect({ ...dry, dryRun: false }).toEqual(first);
    expect(await db.findMany("user", [])).toHaveLength(7);
    const before = await everyRow();
    expect(before.ta_user).toHaveLength(7);
    expect(before.ta_identity).toHaveLength(9);
    expect(before.ta_password).toHaveLength(3);
    const second = await runImport(env.DB, { bundle, options: { formats: LEGACY_FORMATS } });
    expect(second.exists.user).toBe(7);
    expect(second.created).toEqual(NONE);
    expect(await everyRow()).toEqual(before);
  });
});
