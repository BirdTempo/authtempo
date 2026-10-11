import { applyD1Migrations, createScheduledController, env } from "cloudflare:test";
import { createD1Adapter } from "@tempo-auth/adapter-d1";
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

/** Core's tables after the four migrations in packages/adapter-d1/migrations. */
const TABLES = 11;

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
    } finally {
      log.mockRestore();
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
      options: {},
    });
    await expect(runImport(env.DB, clerk(JSON.stringify({ data: [] })))).rejects.toThrow(
      "tempo-auth import: the Clerk organizations input is not a JSON array",
    );
    expect(await everyRow()).toEqual(start);
    // The same bundle with valid organizations writes the user: the refusal
    // above came from the organizations, not from the user.
    const dry = await runImport(env.DB, { ...clerk("[]"), options: { dryRun: true } });
    expect(dry.created.user).toBe(1);
    expect(await everyRow()).toEqual(start);
  });

  it("refuses a bundle of the wrong shape, naming the field, and writes nothing", async () => {
    const start = await everyRow();
    const cases: [unknown, string][] = [
      [null, "the D1 input field (root) is not an object"],
      [{ bundle }, "the D1 input field options is not an object"],
      [
        { bundle, options: { dryRun: "false" } },
        "the D1 input field options.dryRun is not true or false",
      ],
      [{ bundle: [], options: {} }, "the bundle field bundle is not an object"],
      [
        { bundle: { ...bundle, provider: "okta" }, options: {} },
        "the bundle field provider is not one of supabase, clerk, auth0, firebase, authjs, cognito",
      ],
      [
        { bundle: { ...bundle, files: null }, options: {} },
        "the bundle field files is not an object",
      ],
      [
        { bundle: { ...bundle, files: { users: 7, identities } }, options: {} },
        "the bundle field files.users is not text",
      ],
      [
        { bundle: { ...bundle, files: { users, identities, csv: "" } }, options: {} },
        "the bundle field files.csv is not a supabase file",
      ],
      [
        { bundle: { provider: "supabase", files: { users } }, options: {} },
        "the bundle field files.identities is missing; supabase needs it",
      ],
      [
        { bundle: { ...bundle, firebase: { signerKey: "k" } }, options: {} },
        "the bundle field firebase.saltSeparator is not text",
      ],
      [
        { bundle: { ...bundle, firebase: { ...FIREBASE, rounds: "8" } }, options: {} },
        "the bundle field firebase.rounds is not an integer",
      ],
      [
        { bundle: { ...bundle, samePasskeyRpId: "yes" }, options: {} },
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

  it("refuses a malformed bundle and writes nothing", async () => {
    const start = await everyRow();
    const noColumn = users.replace(",is_sso_user", "");
    await expect(
      runImport(env.DB, {
        bundle: { ...bundle, files: { users: noColumn, identities } },
        options: {},
      }),
    ).rejects.toThrow("tempo-auth import: the Supabase users file has no is_sso_user column");
    expect(await everyRow()).toEqual(start);
  });

  it("writes nothing on a dry run, imports, and changes zero rows on the second run", async () => {
    const db = createD1Adapter(env.DB);
    const empty = await everyRow();
    expect(empty.ta_user).toEqual([]);
    const dry = await runImport(env.DB, { bundle, options: { dryRun: true } });
    expect(await everyRow()).toEqual(empty);
    const first = await runImport(env.DB, { bundle, options: {} });
    // The fixture as in test/readers/supabase.test.ts: seven users, three
    // passwords (two bcrypt, one Firebase scrypt), nine identities.
    expect(first.created).toEqual({ ...NONE, user: 7, identity: 9, password: 3 });
    expect({ ...dry, dryRun: false }).toEqual(first);
    expect(await db.findMany("user", [])).toHaveLength(7);
    const before = await everyRow();
    expect(before.ta_user).toHaveLength(7);
    expect(before.ta_identity).toHaveLength(9);
    expect(before.ta_password).toHaveLength(3);
    const second = await runImport(env.DB, { bundle, options: {} });
    expect(second.exists.user).toBe(7);
    expect(second.created).toEqual(NONE);
    expect(await everyRow()).toEqual(before);
  });
});
