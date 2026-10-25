import { describe, expect, it } from "vitest";
import { USERNAME_LENGTH } from "../src/engine/username.js";
import { ipKey } from "../src/limiter/ip-key.js";
import { LIMIT_FAMILIES } from "../src/limiter/limit.js";
import { limiterKey } from "../src/limiter/memory.js";
import { type FieldType, type ModelName, schema } from "../src/schema.js";
import {
  auxColumnType,
  columnType,
  MYSQL_KEY_LIMIT_BYTES,
  MYSQL_STRINGS,
  mysqlKeyBytes,
} from "../src/storage/ddl.js";
import { AUX_TABLES, MYSQL, POSTGRES, SQLITE } from "../src/storage/sql.js";

const MODELS = Object.keys(schema) as ModelName[];

function fieldsOf(model: ModelName): [string, { type: FieldType; int64?: true }][] {
  return Object.entries(schema[model].fields as Record<string, { type: FieldType; int64?: true }>);
}

/** Each key of `model` with its kind: the primary key, each unique key, and each index. */
function keysOf(model: ModelName): { kind: "primary" | "unique" | "index"; fields: string[] }[] {
  return [
    { kind: "primary", fields: ["id"] },
    ...schema[model].unique.map((f) => ({ kind: "unique" as const, fields: [...f] })),
    ...schema[model].indexes.map((f) => ({ kind: "index" as const, fields: [...f] })),
  ];
}

/** Every string field that a key or an index holds, as `<model>.<field>`. */
function keyStrings(): Set<string> {
  const out = new Set<string>();
  for (const m of MODELS)
    for (const k of keysOf(m))
      for (const f of k.fields)
        if (fieldsOf(m).find(([n]) => n === f)?.[1].type === "string") out.add(`${m}.${f}`);
  return out;
}

/** The text of each source file of core, keyed by its path under `src/`. */
const SOURCES = Object.entries(
  import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
).map(([path, text]) => [path.replace(/^\.\.\/src\//, ""), text] as const);

/** The longest value of each part of a limiter key, by the expression that the site writes. */
function longestPart(expr: string): string {
  // The longest form that ipKey gives for an address it parses. A custom
  // clientIp hook can give any string: the MySQL README names that limit.
  if (/^ipKey\(/.test(expr))
    return [ipKey("255.255.255.255"), ipKey("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")].reduce(
      (a, b) => (a.length >= b.length ? a : b),
    );
  // The client of the client_credentials grant: a cl_ id of 46 characters
  // (CLIENT_ID_RE, engine/oauth-clients.ts). Only a client that the app
  // creates holds credentials scopes; a metadata document client holds none.
  if (expr === "client.id") return `cl_${"c".repeat(43)}`;
  // A row id or a session id: 64 characters (the MySQL width of an id).
  if (/(^|\.)(id|userId|organizationId|sid)$/.test(expr)) return "i".repeat(64);
  // The credential id of a SCIM caller that a compat package checked: 1 to
  // 128 characters (scimRequestAs, create-auth.ts; plan 12d Task 14).
  if (expr === "checked.tokenId") return "t".repeat(128);
  // normalizeEmail keeps at most 254 UTF-16 code units: 3 bytes each at most.
  if (/(^|\.)(email|newEmail)$/.test(expr)) return "語".repeat(254);
  // A hash in hex.
  if (/CodeHash$/.test(expr)) return "f".repeat(64);
  // A stored username: ASCII, at most USERNAME_LENGTH.max characters (plan 12i Task 3).
  if (expr === "name.username") return "u".repeat(USERNAME_LENGTH.max);
  // A phone that passed PHONE_RE: a plus and at most 15 digits (plan 12i Task 3).
  if (expr === "input.phone") return `+${"9".repeat(15)}`;
  // The name of an operator secret: at most 32 characters (config.ts).
  if (expr === "entry.name") return "n".repeat(32);
  // The identifier of a phone code after the PHONE_RE check: at most 16 characters (plan 12i Task 4).
  if (expr === "input.identifier") return `+${"9".repeat(15)}`;
  // The one subject of the daily SMS cap (plan 12i).
  if (expr === "CAP_SUBJECT") return "deployment";
  // The one subject of the daily cap of the passkey-first sign-up (ruling 38 M3).
  if (expr === "SIGN_UP_CAP_SUBJECT") return "deployment";
  // The actor of an operator route: `secret:` and a name of 32, or `user:` and an id of 64.
  if (expr === "actorSubject(actor)") return `user:${"i".repeat(64)}`;
  throw new Error(`no longest form for the key part \${${expr}}: give it a row in this test`);
}

/**
 * The longest key that one `limit` call can build (plan 12h): the key is
 * <family>:<subject>. The family argument is a literal, or a choice of
 * literals; each literal with a colon must be a family of LIMIT_FAMILIES.
 * A literal with no colon is a test of the choice, such as "tk".
 */
function longestKey(file: string, family: string, subject: string): string {
  const names = [...family.matchAll(/"([^"]*:[^"]*)"/g)].map((m) => m[1] ?? "");
  if (names.length === 0) throw new Error(`${file}: no family literal in ${family}`);
  for (const n of names)
    expect((LIMIT_FAMILIES as readonly string[]).includes(n), `${file} ${n}`).toBe(true);
  const longest = names.reduce((a, b) => (a.length >= b.length ? a : b));
  return `${longest}:${longestPart(subject)}`;
}

describe("the column map (plan 12g)", () => {
  it("maps each field type on each dialect", () => {
    const sqlite: Record<FieldType, string> = {
      string: "TEXT",
      json: "TEXT",
      boolean: "INTEGER",
      integer: "INTEGER",
      date: "INTEGER",
    };
    const postgres: Record<FieldType, string> = {
      string: "text",
      json: "jsonb",
      boolean: "boolean",
      integer: "integer",
      date: "timestamp with time zone",
    };
    const mysql: Record<FieldType, string> = {
      string: "TEXT",
      json: "JSON",
      boolean: "TINYINT(1)",
      integer: "INT",
      date: "BIGINT",
    };
    for (const m of MODELS)
      for (const [f, def] of fieldsOf(m)) {
        const name = `${m}.${f}`;
        expect(columnType(SQLITE, m, f), name).toBe(sqlite[def.type]);
        expect(columnType(POSTGRES, m, f), name).toBe(def.int64 ? "bigint" : postgres[def.type]);
        const row = MYSQL_STRINGS[name];
        expect(columnType(MYSQL, m, f), name).toBe(
          def.int64
            ? "BIGINT"
            : row === undefined
              ? mysql[def.type]
              : `VARCHAR(${row.length}) CHARACTER SET ${row.charset} COLLATE ${row.charset === "ascii" ? "ascii_bin" : "utf8mb4_0900_bin"}`,
        );
      }
    expect(columnType(MYSQL, "passkey", "credentialId")).toBe(
      "VARCHAR(1364) CHARACTER SET ascii COLLATE ascii_bin",
    );
    expect(columnType(MYSQL, "user", "email")).toBe(
      "VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
    );
  });

  it("marks the 64-bit integers in the schema, not by field name", () => {
    const int64 = MODELS.flatMap((m) =>
      fieldsOf(m)
        .filter(([, def]) => def.int64)
        .map(([f]) => `${m}.${f}`),
    );
    expect(int64).toEqual(["passkey.counter", "totp.lastStep"]);
    for (const m of MODELS)
      for (const [f, def] of fieldsOf(m))
        if (def.type === "integer")
          expect(columnType(POSTGRES, m, f), `${m}.${f}`).toBe(
            int64.includes(`${m}.${f}`) ? "bigint" : "integer",
          );
  });

  it("gives each MySQL key string a row in MYSQL_STRINGS", () => {
    const keyed = keyStrings();
    for (const k of keyed) expect(MYSQL_STRINGS[k], k).toBeDefined();
    // Every row names a string field that a key or an index holds.
    for (const k of Object.keys(MYSQL_STRINGS)) expect(keyed.has(k), k).toBe(true);
    // 81 of version 13, 22 of the six models of version 14 (plan 12d), and
    // the username and the phone of version 15 (plan 12i).
    expect(keyed.size).toBe(105);
  });

  it("keeps each MySQL key under the InnoDB limit", () => {
    expect(MYSQL_KEY_LIMIT_BYTES).toBe(3072);
    for (const m of MODELS)
      for (const k of keysOf(m)) {
        const name = `${m} ${k.kind} (${k.fields.join(", ")})`;
        expect(mysqlKeyBytes(MYSQL, m, k.fields), name).toBeLessThanOrEqual(3072);
        expect(k.fields.length, name).toBeLessThanOrEqual(16);
      }
    expect(mysqlKeyBytes(MYSQL, "identity", ["provider", "subject"])).toBe(64 * 4 + 255 * 4);
    expect(mysqlKeyBytes(MYSQL, "verification", ["identifier"])).toBe(255 * 4);
  });

  it("never puts a prefix on a unique key", () => {
    for (const m of MODELS)
      for (const k of keysOf(m))
        if (k.kind !== "index")
          for (const f of k.fields)
            expect(MYSQL_STRINGS[`${m}.${f}`]?.prefix, `${m}.${f}`).toBeUndefined();
    expect(MYSQL_STRINGS["verification.identifier"]?.prefix).toBe(255);
  });

  it("lists the columns of the tables that are not models", () => {
    expect(
      AUX_TABLES.map((t) => [t.name, t.columns.map((c) => `${c.name} ${c.kind}`), t.primaryKey]),
    ).toEqual([
      ["ta_meta", ["key text", "value text"], ["key"]],
      ["ta_limit", ["key text", "window_start int64", "count int64", "expires_at int64"], ["key"]],
    ]);
    expect(AUX_TABLES[1]?.indexes).toEqual([
      { name: "ix_ta_limit__expires_at", columns: ["expires_at"] },
    ]);
    // `key` is a reserved word of MySQL, so the MySQL statements of the limiter and the gate quote it (Task 5).
    expect(auxColumnType(MYSQL, "ta_limit", "key")).toBe("VARBINARY(3072)");
    expect(auxColumnType(MYSQL, "ta_limit", "expires_at")).toBe("BIGINT");
    expect(auxColumnType(MYSQL, "ta_meta", "key")).toBe(
      "VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin",
    );
    expect(auxColumnType(MYSQL, "ta_meta", "value")).toBe("TEXT");
    expect(auxColumnType(POSTGRES, "ta_limit", "count")).toBe("bigint");
    expect(auxColumnType(SQLITE, "ta_limit", "key")).toBe("TEXT");
  });

  it("keeps the stored key of each limiter site within ta_limit.key on MySQL", () => {
    // Ruling 3 of plan 12g: ta_limit.key is VARBINARY(3072). Each limit call
    // of core is found in the source, so a new site with no longest form fails.
    // Since plan 12h each site calls limit(config, family, subject, window).
    const sites: string[] = [];
    const longest = new Map<string, number>();
    let calls = 0;
    const part = String.raw`((?:[^,()]|\([^()]*\))+?)`;
    const call = new RegExp(String.raw`(?<![\w.])limit\(\s*[\w.]+,\s*${part},\s*${part},`, "g");
    for (const [file, text] of SOURCES) {
      if (file.startsWith("limiter/")) continue;
      calls += text.match(/(?<![\w.])limit\(/g)?.length ?? 0;
      for (const m of text.matchAll(call)) {
        const family = (m[1] ?? "").replace(/\s+/g, " ").trim();
        const subject = (m[2] ?? "").trim();
        const arg = `${family} ${subject}`;
        const stored = limiterKey(longestKey(file, family, subject), {
          seconds: Number.MAX_SAFE_INTEGER,
          max: Number.MAX_SAFE_INTEGER,
        });
        const bytes = new TextEncoder().encode(stored).length;
        expect(bytes, `${file} ${arg}`).toBeLessThanOrEqual(3072);
        sites.push(`${file} ${arg}`);
        longest.set(`${file} ${arg}`, bytes);
      }
    }
    // Each call has a key form that this test reads: a call it cannot read fails here.
    expect(sites.length).toBe(calls);
    // The count of the call sites at the 12k merge, the same after plan 12h.
    // Plan 12d adds 8: the SSO manager, the domain verify, the discovery, the
    // start, the ACS, and the three of the SCIM token check. Plan 12i adds 1:
    // the password:user key of a check with no address (ruling 15). Plan 12i
    // Task 2 adds 2: the username set and the availability check. Plan 12i
    // Task 3 adds 2: the password sign-in by username and by phone. Plan 12i
    // Task 4 adds 6: the three request keys, the daily cap, and the two
    // verify keys of the phone code. Plan 12i Task 5 adds 1: the phone add
    // per user. Its fix round adds 1: the phone add per number (ruling 23).
    // Plan 12i Task 6 adds 3: the anonymous sign-in per IP, its daily cap
    // (ruling 25 M4), and its delete per user. Plan 12i Task 11 adds 1: the
    // per-IP key of the multi-session routes. Plan 12i Task 10 adds 2: the
    // per-IP keys of the ID-token nonce and sign-in. Plan 12i Task 20 adds 2:
    // the per-IP and the per-address keys of the sign-up code. Ruling 39 adds
    // 1: the day cap of the sign-up code mails. Plan 12i Task 8 adds 2: the
    // per-IP keys of the passkey-first sign-up options and its verify.
    // Ruling 38 adds 1: the daily cap of the passkey-first sign-up. Plan 12f2
    // Task 5 adds 1: the per-actor count of the operator delete. Plan 12f2
    // Task 3 adds 1: the per-IP count of the invitation confirm. Plan 12f2
    // Task 5 adds 1: the per-actor count of the operator create.
    expect(sites.length).toBe(112);
    expect(sites).toContain('engine/user-invite.ts "user-invite-confirm:ip" ipKey(input.ip)');
    expect(sites).toContain('http/routes/operator.ts "operator-create:actor" actorSubject(actor)');
    expect(sites).toContain('engine/id-token.ts "id-token:ip" ipKey(input.ip)');
    expect(sites).toContain('engine/password.ts "password-verify-code:email-day" email');
    expect(sites).toContain('engine/passkeys.ts "passkey-sign-up:all-day" SIGN_UP_CAP_SUBJECT');
    expect(sites).toContain('engine/phone.ts "phone-add:phone" input.phone');
    expect(sites).toContain('http/routes/multi-session.ts "multi-session:ip" ipKey(ctx.ip)');
    expect(sites).toContain('engine/phone.ts "phone-otp:all-day" CAP_SUBJECT');
    expect(sites).toContain('engine/anonymous.ts "anonymous:all-day" CAP_SUBJECT');
    expect(sites).toContain('engine/slug-check.ts "slug-check:user" userId');
    expect(sites).toContain(
      'engine/token-use.ts kind === "tk" ? "token-use:tk" : "token-use:to" row.id',
    );
    // 25 characters of prefix, the 46 of a cl_ id, and two separators with
    // the two 16-digit window values.
    expect(longest.get('engine/oauth-credentials.ts "oauth-credentials:client" client.id')).toBe(
      105,
    );
  });
});
