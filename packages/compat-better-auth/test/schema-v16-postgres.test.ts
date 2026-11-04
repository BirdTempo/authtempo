import { expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { COMPAT_MIGRATION_NAMES, compatPostgresSteps } from "../src/storage/migration.js";
import { BETTER_AUTH_PG, CONSUMER_I_PG } from "./fixtures.js";
import { freshBetterAuthSchema } from "./pg.js";

// Compat migration 0013 on Postgres (plan 12p). Better Auth's session table
// gets taProved, and the fill joins Better Auth's user table through the
// app's naming. Core's field reads it through the mapping.

const CASES = [
  { title: "camelCase", tables: BETTER_AUTH_PG, casing: "camel" as const },
  { title: "snake_case", tables: CONSUMER_I_PG, casing: "snake" as const },
];

for (const { title, tables, casing } of CASES) {
  it(`fills taProved from the user of each Better Auth session on Postgres, ${title} (plan 12p)`, async () => {
    const pg = await freshBetterAuthSchema(tables);
    try {
      const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql, casing });
      const n = s.names;
      // Rows as Better Auth wrote them before the cutover. A verified user with an
      // address, a claimant with an unverified address, and an anonymous user with
      // Better Auth's placeholder (a user with no address in core).
      const u = (f: string) => n.column("user", f);
      const user = (id: string, email: string, verified: boolean) =>
        pg.sql.unsafe(
          `INSERT INTO ${n.table("user")} (${u("id")}, ${u("name")}, ${u("email")}, ${u("emailVerified")}, ${u("createdAt")}, ${u("updatedAt")}) VALUES ($1, '', $2, $3, now(), now())`,
          [id, email, verified],
        );
      await user("uv", "uv@example.com", true);
      await user("uu", "uu@example.com", false);
      await user("ua", "ua@anonymous.placeholder.invalid", false);
      // A Better Auth row that holds a placeholder and the verified flag. The storage
      // reads its address as none, so the fill must not trust the flag.
      await user("ut", "ut@tiktok.placeholder.invalid", true);
      const c = (f: string) => n.column("session", f);
      for (const [id, userId] of [
        ["sv", "uv"],
        ["sv2", "uv"],
        ["su", "uu"],
        ["sa", "ua"],
        ["st", "ut"],
      ] as const)
        await pg.sql.unsafe(
          `INSERT INTO ${n.table("session")} (${c("id")}, ${c("expiresAt")}, ${c("token")}, ${c("createdAt")}, ${c("updatedAt")}, ${c("userId")}) VALUES ($1, '2100-01-01T00:00:00Z', $2, now(), now(), $3)`,
          [id, `h-${id}`, userId],
        );
      // The runner applies every compat migration, 0013 last.
      expect(await s.migrate()).toEqual([...COMPAT_MIGRATION_NAMES]);
      expect(COMPAT_MIGRATION_NAMES.at(-1)).toBe("0013_compat_schema_v16");
      const meta = await pg.sql.unsafe<{ key: string; value: string }[]>(
        "SELECT key, value FROM ta_meta ORDER BY key",
      );
      expect([...meta]).toEqual([
        { key: "compat_better_auth", value: "13" },
        { key: "schema_version", value: "16" },
      ]);
      const column = await pg.sql.unsafe<
        { is_nullable: string; data_type: string; column_default: string | null }[]
      >(
        "SELECT is_nullable, data_type, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
        [n.rawTable("session"), n.rawColumn("session", "taProved")],
      );
      expect([...column]).toEqual([
        { is_nullable: "NO", data_type: "boolean", column_default: "false" },
      ]);
      // Core's field reads the column through the mapping.
      const proved = async (value: boolean) =>
        (
          await s.storage.findMany("session", [{ field: "proved", op: "eq", value }], {
            sort: { field: "id", dir: "asc" },
          })
        ).map((r) => r.id);
      expect(await proved(true)).toEqual(["sv", "sv2"]);
      expect(await proved(false)).toEqual(["sa", "st", "su"]);
      expect(
        await s.storage.findOne("session", [{ field: "id", op: "eq", value: "sv" }]),
      ).toMatchObject({ userId: "uv", tokenHash: "h-sv", proved: true });
    } finally {
      await pg.close();
    }
  });
}

it("migrates a compat store with no session on Postgres (plan 12p)", async () => {
  const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
  try {
    const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    // The steps before 0013: a store of compat 12 with no row.
    const steps = compatPostgresSteps(s.names);
    for (const step of steps.slice(0, -1)) await pg.sql.begin((tx) => tx.unsafe(step.text));
    expect(await s.migrate()).toEqual(["0013_compat_schema_v16"]);
    expect(await s.storage.findMany("session", [])).toEqual([]);
  } finally {
    await pg.close();
  }
});
