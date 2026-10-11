import { applyD1Migrations, createScheduledController, env } from "cloudflare:test";
import { createD1Adapter } from "@tempo-auth/adapter-d1";
import { FIREBASE } from "@tempo-auth/legacy-hashes/testing";
import { describe, expect, it, vi } from "vitest";
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
      await worker.scheduled(createScheduledController(), env);
      expect(log).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(line.tempoAuthImport).toMatchObject({ dryRun: true, created: NONE });
    } finally {
      log.mockRestore();
    }
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
    await expect(
      runImport(env.DB, { bundle: { provider: "supabase", files: { users } }, options: {} }),
    ).rejects.toThrow("tempo-auth import: supabase needs --identities");
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
