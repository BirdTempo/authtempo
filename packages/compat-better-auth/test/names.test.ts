import { describe, expect, it } from "vitest";
import { namesFromDrizzle } from "../src/adapters/drizzle.js";
import { resolveNames, snake } from "../src/storage/names.js";
import { BETTER_AUTH_PG, countForeignKeys, CONSUMER_I_PG } from "./fixtures.js";

const NAME = Symbol.for("drizzle:Name");
const SCHEMA = Symbol.for("drizzle:Schema");
const COLUMNS = Symbol.for("drizzle:Columns");
/** A stand-in for a Drizzle table object, with the three symbols drizzle-orm 0.45.2 sets (table.js, table.utils.js). */
function drizzleTable(name: string, columns: Record<string, string>, schema?: string): object {
  return {
    [NAME]: name,
    [SCHEMA]: schema,
    [COLUMNS]: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, { name: v }])),
  };
}

describe("names", () => {
  it("turns a Better Auth field into snake_case the way Drizzle schemas name them", () => {
    expect(
      ["emailVerified", "credentialID", "taLastSeenAt", "accessTokenExpiresAt", "aaguid"].map(
        snake,
      ),
    ).toEqual([
      "email_verified",
      "credential_id",
      "ta_last_seen_at",
      "access_token_expires_at",
      "aaguid",
    ]);
  });

  it("quotes every name and qualifies a table with the Postgres schema", () => {
    const n = resolveNames({ pgSchema: "auth" });
    expect(n.table("user")).toBe('"auth"."user"');
    expect(n.column("user", "emailVerified")).toBe('"emailVerified"');
    const s = resolveNames({
      casing: "snake",
      tables: { user: "users" },
      columns: { passkey: { credentialID: "cred_id" } },
    });
    expect(s.table("user")).toBe('"users"');
    expect(s.column("passkey", "credentialID")).toBe('"cred_id"');
    expect(s.column("session", "taLastSeenAt")).toBe('"ta_last_seen_at"');
    expect(s.fieldOf("passkey", "cred_id")).toBe("credentialID");
    expect(s.fieldOf("account", "provider_id")).toBe("providerId");
    expect(s.fieldOf("account", "nope")).toBeNull();
  });

  it("refuses a name that is not a plain identifier", () => {
    expect(() => resolveNames({ tables: { user: 'user"; drop table x; --' } })).toThrow(
      /plain SQL identifier/,
    );
    expect(() => resolveNames({ pgSchema: "a b" })).toThrow(/plain SQL identifier/);
  });

  it("reads the table and column names from Drizzle table objects (consumere's plural map)", () => {
    const options = namesFromDrizzle(
      {
        user: drizzleTable("users", {
          id: "id",
          emailVerified: "email_verified",
          createdAt: "created_at",
        }),
        account: drizzleTable("accounts", { providerId: "provider_id", accountId: "account_id" }),
        verification: drizzleTable("verifications", { identifier: "identifier" }),
      },
      false,
    );
    const n = resolveNames(options);
    expect(n.table("user")).toBe('"users"');
    expect(n.table("session")).toBe('"session"');
    expect(n.column("user", "emailVerified")).toBe('"email_verified"');
    // A field the Drizzle object does not list follows the detected casing.
    expect(n.column("account", "taLinkedAt")).toBe('"ta_linked_at"');
  });

  it("reads the Postgres schema from the Drizzle user table (consumerc's auth schema)", () => {
    const n = resolveNames(
      namesFromDrizzle(
        { user: drizzleTable("user", { emailVerified: "email_verified" }, "auth") },
        false,
      ),
    );
    expect(n.table("member")).toBe('"auth"."member"');
  });

  it("names plural tables for usePlural", () => {
    const n = resolveNames(namesFromDrizzle(undefined, true));
    expect([n.table("user"), n.table("verification"), n.table("passkey")]).toEqual([
      '"users"',
      '"verifications"',
      '"passkeys"',
    ]);
  });
});

describe("fixtures", () => {
  it("hold seven foreign keys: five name user, two name organization", () => {
    // session, account, member, invitation inviter, and passkey name "user"; member and invitation name "organization".
    const clauses = (text: string, table: string) =>
      text.split(` references "${table}" ("id") on delete cascade`).length - 1;
    for (const text of [BETTER_AUTH_PG, CONSUMER_I_PG]) {
      expect(countForeignKeys(text)).toBe(7);
      expect([clauses(text, "user"), clauses(text, "organization")]).toEqual([5, 2]);
    }
  });
});
