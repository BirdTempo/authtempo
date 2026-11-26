import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPostgresMigrations, createPostgresAdapter } from "@authtempo/adapter-postgres";
import { createMemoryAdapter, type StorageAdapter, StorageError } from "@authtempo/core";
import { CONFLICT_REASONS, exitCode, type ImportReport, importId } from "@authtempo/import";
import { LEGACY_FORMATS } from "@authtempo/legacy-hashes";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
// The fixtures stay with the readers in packages/import: plan 11c moved the CLI, not the readers.
import { SUPABASE_FIXTURE_CREATED } from "../../import/test/fixtures/supabase-counts.js";
import identities from "../../import/test/fixtures/supabase-identities.csv?raw";
import users from "../../import/test/fixtures/supabase-users.csv?raw";
import { FIRESCRYPT } from "../../import/test/readers/all.js";
import { type CliIo, parseImportValues, runParsed } from "../src/commands/import-core.js";
import { main } from "../src/main.js";
import { assertFreshBuild, linesOf, runBin } from "./support/bin.js";
import { fakeIo } from "./support/fake-io.js";
import { freshDatabase } from "./support/pg.js";

// The flows of `authtempo import` that the suite of the first import CLI
// held: the report, the exit codes, the stops, and the inputs of each
// provider. Release 0.2.0 removed the old binary, and its suite moved here
// with the flags of the command. A flow with no database runs in process
// with a fake io. A flow that writes rows runs as a child process on the
// docker compose Postgres.

/** Every format: the tests below that do not test --formats pass all five. */
const ALL = LEGACY_FORMATS.join(",");

const BCRYPT = "$2b$10$U4C0ZY8OG8y41F9LusfKyu3HRMBL0rCZcKBVsXhgr.n8Ou6FPhzO2";

const CLERK_CSV = `id,first_name,last_name,username,primary_email_address,primary_phone_number,verified_email_addresses,unverified_email_addresses,verified_phone_numbers,unverified_phone_numbers,totp_secret,password_digest,password_hasher
user_2a,Kim,Lee,,kim@example.com,,kim@example.com,,,,,${BCRYPT},bcrypt
`;
const CLERK_USERS = JSON.stringify([
  {
    id: "user_2a",
    first_name: "Kim",
    last_name: "Lee",
    primary_email_address_id: "idn_1",
    email_addresses: [
      { id: "idn_1", email_address: "kim@example.com", verification: { status: "verified" } },
    ],
    external_accounts: [],
    password_enabled: true,
    created_at: 1700000000000,
  },
]);
const clerkOrg = (slug: string) =>
  JSON.stringify([
    {
      id: "org_1",
      name: "Acme",
      slug,
      created_at: 1700000000000,
      memberships: [{ role: "org:admin", public_user_data: { user_id: "user_2a" } }],
    },
  ]);

/** A Firebase export of one user, with a hash of the project of the test vectors. */
const FIREBASE_USERS = JSON.stringify({
  users: [
    {
      localId: "fbuid1",
      email: "user1@example.com",
      emailVerified: true,
      passwordHash:
        "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==",
      salt: "42xEC+ixf3L2lw==",
    },
  ],
});

const SUPABASE = ["supabase", "--users", "u.csv", "--identities", "i.csv"];
const CLERK = ["clerk", "--csv", "c.csv", "--users", "u.json", "--formats", ALL];
/** The plan against an empty store: the readers and the report run, and no database opens. */
const PLAN = ["--target", "memory", "--dry-run"];
/** The Postgres target with the connection string in the variable TEST_DB_URL. */
const PG = ["--target", "postgres", "--url-env", "TEST_DB_URL"];
/** A port that refuses each connection: a run that opens the storage stops with ECONNREFUSED. */
const REFUSED_URL = "postgres://app:s3cret-canary@127.0.0.1:1/none";
const CONNECTING = "connecting to 127.0.0.1:1/none";
const CREATED_ONE = "created: user 1, identity 1, password 1, passkey 0, organization 0, member 0";

/** The files of a fake io: each name is a file of the folder /work, the cwd of the run. */
const inWork = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([name, text]) => [`/work/${name}`, text]));

/** Runs `authtempo import` in process with a fake io. Each file has mode 0600. */
async function run(
  args: readonly string[],
  files: Record<string, string>,
  o: { env?: Record<string, string>; modes?: Record<string, number> } = {},
) {
  const io = fakeIo({ files: inWork(files), ...o });
  const code = await main(["import", ...args], io);
  return { code, io };
}

const SUPABASE_FILES = { "u.csv": users, "i.csv": identities };

describe("authtempo import: the flag checks", () => {
  it("refuses each usage error with exit 2, before any file read", async () => {
    const bundle = ["--target", "d1-bundle", "--out", "b.json"];
    const base = [...SUPABASE, "--formats", ALL, ...bundle];
    const cases: [string[], string][] = [
      [
        ["nope", "--users", "u.csv", ...bundle],
        "name one provider: supabase, clerk, auth0, firebase, authjs, cognito, workos",
      ],
      [
        ["supabase", "--users", "u.csv", "--formats", ALL, ...bundle],
        "supabase needs --identities",
      ],
      [[...base, "--hashes", "u.csv"], "supabase takes no --hashes"],
      [[...base, "--on-email-taken", "merge"], "--on-email-taken is skip or fail"],
      [[...SUPABASE, "--formats", "md5", ...bundle], "--formats: unknown format md5"],
      [
        [...base, "--role-map", "billing=boss"],
        "--role-map: billing=boss is not <source role>=owner|admin|member",
      ],
      [[...base, "--unknown-flag"], "unknown flag --unknown-flag"],
      [[...base, "--firebase-rounds", "8"], "supabase takes no --firebase-rounds"],
      [
        [...base, "--firebase-signer-key-env", "SIGNER"],
        "give both --firebase-signer-key-env and --firebase-salt-separator, or neither",
      ],
      [[...base, "--password-column", "pw"], "supabase takes no --password-column"],
      [[...base, "--reserved-slugs", ""], "--reserved-slugs: an empty entry"],
      [[...base, "--platform-slug", "Not A Slug!"], "Not A Slug! is not a slug"],
      // A file that does not exist: the flag check comes first, so no read fails.
      [
        ["supabase", "--users", "missing.csv", "--formats", ALL, ...bundle],
        "supabase needs --identities",
      ],
      // An empty --out names no file, so the run has no target.
      [
        [...SUPABASE, "--formats", ALL, "--target", "d1-bundle", "--out", ""],
        "name exactly one target: postgres, d1-bundle, or memory",
      ],
    ];
    for (const [argv, message] of cases) {
      const { code, io } = await run(argv, SUPABASE_FILES, { env: { SIGNER: "k" } });
      expect(code, argv.join(" ")).toBe(2);
      expect(io.stderr[0], argv.join(" ")).toBe(message);
      // A usage error prints the usage of the command after its message.
      expect(io.stderr[1], argv.join(" ")).toMatch(/^Usage: authtempo import <provider> /);
      expect(io.stdout).toEqual([]);
      // Every flag check runs before the first file read (review M-1).
      expect(io.reads, argv.join(" ")).toEqual([]);
      expect(io.files.has("/work/b.json"), argv.join(" ")).toBe(false);
    }
  });

  it("refuses firebase with no --firebase-rounds or no --firebase-mem-cost, before any file read", async () => {
    for (const flags of [
      ["--firebase-mem-cost", "14"],
      ["--firebase-rounds", "8"],
    ]) {
      const { code, io } = await run(
        ["firebase", "--users", "f.json", ...flags, "--formats", "firescrypt", ...PLAN],
        { "f.json": JSON.stringify({ users: [] }) },
      );
      expect(code, flags.join(" ")).toBe(2);
      expect(io.stderr[0]).toBe("firebase needs --firebase-rounds and --firebase-mem-cost");
      expect(io.stderr[1]).toMatch(/^Usage: authtempo import <provider> /);
      expect(io.reads).toEqual([]);
    }
  });

  it("refuses a provider with no --formats, before any file read", async () => {
    // Spec 17.1: only the operator knows the seam's list, so there is no default.
    const { code, io } = await run([...SUPABASE, ...PG], SUPABASE_FILES, {
      env: { TEST_DB_URL: REFUSED_URL },
    });
    expect(code).toBe(2);
    expect(io.stderr[0]).toBe(
      "supabase needs --formats: the formats list of the app's createLegacyPasswordHash, or none",
    );
    expect(io.stderr[1]).toMatch(/^Usage: authtempo import <provider> /);
    expect(io.reads).toEqual([]);
    // No storage opened: the open prints the "connecting to" line first.
    expect(io.stderr).not.toContain(CONNECTING);
  });

  it("lists --repair in the help", async () => {
    const io = fakeIo();
    expect(await main(["import", "--help"], io)).toBe(0);
    expect(io.stdout.some((l) => l.includes("--repair"))).toBe(true);
  });
});

describe("authtempo import: the D1 bundle", () => {
  it("writes the input and the options into the bundle, and opens no storage", async () => {
    const { code, io } = await run(
      [
        ...SUPABASE,
        "--target",
        "d1-bundle",
        "--out",
        "b.json",
        "--legacy-verify",
        "--reserved-slugs",
        "billing,help",
        "--platform-slug",
        "staff",
        "--formats",
        "bcrypt,argon2id",
      ],
      SUPABASE_FILES,
      // A set connection string must not matter: the bundle target reads none.
      { env: { DATABASE_URL: REFUSED_URL } },
    );
    expect(code).toBe(0);
    const b = JSON.parse(io.files.get("/work/b.json") ?? "{}");
    expect(b.bundle).toMatchObject({ provider: "supabase", files: { users, identities } });
    expect(b.options).toMatchObject({
      legacyVerify: true,
      onEmailTaken: "skip",
      dryRun: false,
      reservedSlugs: ["billing", "help"],
      platformSlug: "staff",
      formats: ["bcrypt", "argon2id"],
    });
    expect(io.stderr).toEqual([]);
  });
});

describe("authtempo import: the report and the exit status", () => {
  it("exits 1 on a refusal: an organization slug in --reserved-slugs", async () => {
    const { code, io } = await run(
      [...CLERK, "--organizations", "o.json", "--reserved-slugs", "billing", ...PLAN],
      { "c.csv": CLERK_CSV, "u.json": CLERK_USERS, "o.json": clerkOrg("billing") },
    );
    expect(io.stdout).toContain("skipped organization org_1: reserved_slug");
    expect(io.stdout).toContain("refusals: 1");
    expect(code).toBe(1);
  });

  it("passes --platform-slug: an organization cannot take the platform slug", async () => {
    const files = { "c.csv": CLERK_CSV, "u.json": CLERK_USERS, "o.json": clerkOrg("staff") };
    const args = [...CLERK, "--organizations", "o.json", ...PLAN];
    const { code, io } = await run([...args, "--platform-slug", "staff"], files);
    expect(io.stdout).toContain("skipped organization org_1: reserved_slug");
    expect(code).toBe(1);
    // Without the flag, the same export imports the organization.
    const plain = await run(args, files);
    expect(plain.io.stdout).toContain("refusals: 0");
    expect(plain.code).toBe(0);
  });

  it("exits 0 on a Supabase SSO user, and the report lists it", async () => {
    const rows = users.split("\n");
    const sso = rows.find((l) => l.startsWith("aaaaaaaa-"));
    expect(sso).toBeDefined();
    const { code, io } = await run([...SUPABASE, "--formats", ALL, ...PLAN], {
      "u.csv": [...rows.slice(0, 3), sso].join("\n"),
      "i.csv": identities,
    });
    expect(code).toBe(0);
    expect(io.stdout).toContain("skipped user aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa: sso_user");
    expect(io.stdout).toContain("refusals: 0");
  });

  it("exits 1 on a partial record and on every conflict reason, and 0 on a policy skip", () => {
    const report = (over: Partial<ImportReport>): ImportReport => ({
      source: "clerk",
      dryRun: false,
      created: { user: 0, identity: 0, password: 0, passkey: 0, organization: 0, member: 0 },
      exists: { user: 0, organization: 0 },
      skipped: [],
      refusedHashes: [],
      dropped: [],
      refusals: 0,
      hashFormats: {},
      partial: [],
      repaired: [],
      ...over,
    });
    expect(
      exitCode(report({ partial: [{ kind: "user", sourceId: "u", missing: ["password"] }] })),
    ).toBe(1);
    expect(CONFLICT_REASONS.has("duplicate_row")).toBe(true);
    for (const reason of CONFLICT_REASONS)
      expect(exitCode(report({ skipped: [{ kind: "user", sourceId: "u", reason }] })), reason).toBe(
        1,
      );
    for (const reason of ["banned", "deleted", "anonymous", "disabled", "sso_user"] as const)
      expect(exitCode(report({ skipped: [{ kind: "user", sourceId: "u", reason }] })), reason).toBe(
        0,
      );
  });
});

describe("authtempo import: the stops before the storage opens", () => {
  it("stops with exit 2 before any write when a reader refuses a malformed file", async () => {
    // The Clerk reader reads organizations after it yields the users: without
    // the read-first pass, the users would be written before the error.
    const { code, io } = await run(
      [...CLERK, "--organizations", "o.json", "--report", "r.json", ...PG],
      { "c.csv": CLERK_CSV, "u.json": CLERK_USERS, "o.json": "{}" },
      { env: { TEST_DB_URL: REFUSED_URL } },
    );
    expect(code).toBe(2);
    // One line: the open of the storage would print the "connecting to" line.
    expect(io.stderr).toHaveLength(1);
    expect(io.stderr[0]).toMatch(
      /^stopped: .*Clerk organizations input is not a JSON array.*; nothing was written$/,
    );
    expect(io.stdout).toEqual([]);
    // The report file says the run stopped, so an older file cannot pass for this run.
    const report = JSON.parse(io.files.get("/work/r.json") ?? "{}");
    expect(report).toMatchObject({ report: null });
    expect(report.stopped).toMatch(/Clerk organizations/);
  });

  it("stops with exit 2 before the storage opens on an out-of-bounds Firebase hashConfig", async () => {
    const { code, io } = await run(
      [
        "firebase",
        "--users",
        "f.json",
        "--firebase-rounds",
        "8",
        "--firebase-mem-cost",
        "99",
        "--formats",
        "firescrypt",
        ...PG,
      ],
      { "f.json": JSON.stringify({ users: [] }) },
      { env: { TEST_DB_URL: REFUSED_URL } },
    );
    expect(code).toBe(2);
    expect(io.stderr).toEqual([
      expect.stringMatching(/^stopped: .*firebase hashConfig rounds and memCost/),
    ]);
  });

  it("stops with exit 2 on a bare Cognito Users array (list-users --query Users), nothing written", async () => {
    const { code, io } = await run(
      ["cognito", "--users", "c.json", "--legacy-verify", ...PG],
      { "c.json": "[]" },
      { env: { TEST_DB_URL: REFUSED_URL } },
    );
    expect(code).toBe(2);
    expect(io.stderr).toEqual([
      expect.stringMatching(
        /^stopped: authtempo import: the Cognito users input has no Users array.*; nothing was written$/,
      ),
    ]);
  });
});

describe("authtempo import: a storage that fails", () => {
  it("prints one stopped line and writes the report file on a refused connection", async () => {
    const { code, io } = await run(
      [...SUPABASE, "--formats", ALL, "--report", "r.json", ...PG],
      SUPABASE_FILES,
      { env: { TEST_DB_URL: REFUSED_URL } },
    );
    expect(code).toBe(2);
    // The driver's text is not printed (spec 19): the code and the host only.
    expect(io.stderr).toEqual([
      CONNECTING,
      "stopped: storage: ECONNREFUSED at 127.0.0.1:1/none; nothing was written",
    ]);
    expect(io.stdout).toEqual([]);
    expect(JSON.parse(io.files.get("/work/r.json") ?? "{}")).toEqual({
      stopped: "storage: ECONNREFUSED at 127.0.0.1:1/none; nothing was written",
      report: null,
    });
  });

  it("scrubs the connection string of --url-env and its password from every line, also from a line that echoes the password", async () => {
    // The name of the users file holds the password, and other users can read
    // the file. So the file mode warning echoes the password.
    const { code, io } = await run(
      [
        "supabase",
        "--users",
        "s3cret-canary.csv",
        "--identities",
        "i.csv",
        "--formats",
        ALL,
        ...PG,
      ],
      { "s3cret-canary.csv": users, "i.csv": identities },
      { env: { TEST_DB_URL: REFUSED_URL }, modes: { "/work/s3cret-canary.csv": 0o644 } },
    );
    expect(code).toBe(2);
    expect(io.stderr).toEqual([
      "warning: ***.csv is readable by other users of this machine; an export holds addresses and can hold password hashes",
      CONNECTING,
      "stopped: storage: ECONNREFUSED at 127.0.0.1:1/none; nothing was written",
    ]);
    for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain("s3cret-canary");
  });

  /** The io of the run of import-core.ts, with a storage that the test gives. */
  function coreIo(storage: StorageAdapter) {
    const out: string[] = [];
    const err: string[] = [];
    const written: Record<string, string> = {};
    const files: Record<string, string> = SUPABASE_FILES;
    const value: CliIo = {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      readFile: (p) => {
        const f = files[p];
        if (f === undefined) throw new Error(`ENOENT: ${p}`);
        return f;
      },
      writeFile: (p, t) => {
        written[p] = t;
      },
      openStorage: async () => ({ storage, close: async () => {} }),
      openMemory: async () => {
        throw new Error("this run names the Postgres target");
      },
    };
    return { value, out, err, written };
  }

  it("names a storage error and any other error of a write apart, each in one stopped line", async () => {
    // `authtempo import` opens its storage through the Postgres seam, so a
    // write that fails in the middle of a run needs the run of import-core.ts
    // with a storage of the test. The command calls the same two functions.
    const values = {
      users: "u.csv",
      identities: "i.csv",
      formats: ALL,
      postgres: "postgres://x",
      report: "r.json",
    };
    const failing = (error: Error) => {
      const storage = createMemoryAdapter();
      storage.transaction = async () => {
        throw error;
      };
      return coreIo(storage);
    };

    // "storage:" only for a StorageError; any other error is the importer's own.
    const mid = failing(new StorageError("schema_mismatch", "user"));
    const midRun = await runParsed(parseImportValues(["supabase"], values, mid.value), mid.value);
    expect(midRun.code).toBe(2);
    expect(mid.err).toEqual([
      "stopped: storage: schema_mismatch on user; records before it may be written; run again",
    ]);
    expect(midRun.stopped).toBe(
      "storage: schema_mismatch on user; records before it may be written; run again",
    );
    expect(JSON.parse(mid.written["r.json"] ?? "{}")).toMatchObject({ report: null });

    const other = failing(new Error("terminating connection"));
    const otherRun = await runParsed(
      parseImportValues(["supabase"], values, other.value),
      other.value,
    );
    expect(otherRun.code).toBe(2);
    expect(other.err).toEqual([
      "stopped: import: terminating connection; records before it may be written; run again",
    ]);
  });
});

describe("authtempo import: each provider's inputs reach its reader", () => {
  it("clerk: the CSV and the API JSON", async () => {
    const { code, io } = await run([...CLERK, ...PLAN], {
      "c.csv": CLERK_CSV,
      "u.json": CLERK_USERS,
    });
    expect(code).toBe(0);
    expect(io.stdout).toContain(CREATED_ONE);
  });

  it("auth0: the users NDJSON and the hash file", async () => {
    const files = {
      "u.ndjson": JSON.stringify({
        user_id: "auth0|o7p6",
        email: "ann@example.com",
        email_verified: true,
        identities: [{ provider: "auth0", user_id: "o7p6", isSocial: false }],
      }),
      "h.ndjson": JSON.stringify({
        _id: { $oid: "o7p6" },
        email: "ann@example.com",
        passwordHash: BCRYPT,
      }),
    };
    const args = ["auth0", "--users", "u.ndjson", "--formats", "bcrypt", ...PLAN];
    const { code, io } = await run([...args, "--hashes", "h.ndjson"], files);
    expect(code).toBe(0);
    expect(io.stdout).toContain(CREATED_ONE);
    // Without the hash file, the same user imports with no password, and one line says so.
    const bare = await run(args, files);
    expect(bare.io.stdout).toContain("auth0: no --hashes file; no password is imported");
    expect(bare.io.stdout).toContain(
      "created: user 1, identity 1, password 0, passkey 0, organization 0, member 0",
    );
  });

  it("authjs: the tables, the password column, and the same relying party id", async () => {
    const files = {
      "t.json": JSON.stringify({
        users: [
          {
            id: "cuid1",
            name: "Ida",
            email: "ida@example.com",
            emailVerified: "2024-01-01T00:00:00.000Z",
            image: null,
            pw: BCRYPT,
          },
        ],
        accounts: [],
        authenticators: [
          {
            credentialID: "AQID+/8=",
            userId: "cuid1",
            providerAccountId: "x",
            credentialPublicKey: "pQECAyYgAA==",
            counter: 4,
            credentialDeviceType: "multiDevice",
            credentialBackedUp: true,
            transports: "internal",
          },
        ],
      }),
    };
    const { code, io } = await run(
      [
        "authjs",
        "--authjs-tables",
        "t.json",
        "--password-column",
        "pw",
        "--same-passkey-rp-id",
        "--formats",
        "bcrypt",
        ...PLAN,
      ],
      files,
    );
    expect(code).toBe(0);
    expect(io.stdout).toContain(
      "created: user 1, identity 1, password 1, passkey 1, organization 0, member 0",
    );
  });

  it("cognito: the users JSON, and the marker only under --legacy-verify", async () => {
    const files = {
      "c.json": JSON.stringify({
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
    };
    const args = ["cognito", "--users", "c.json", ...PLAN];
    const on = await run([...args, "--legacy-verify"], files);
    expect(on.code).toBe(0);
    expect(on.io.stdout).toContain(CREATED_ONE);
    const off = await run(args, files);
    expect(off.code).toBe(1);
  });
});

describe("authtempo import on Postgres: the rows of a real run", () => {
  const ADA = "11111111-1111-4111-8111-111111111111";
  let dir: string;
  let db: Awaited<ReturnType<typeof freshDatabase>>;

  beforeAll(() => {
    assertFreshBuild();
    dir = mkdtempSync(join(tmpdir(), "authtempo-flows-"));
    // Mode 0600: a wider file adds the file mode warning to stderr.
    for (const [name, text] of Object.entries({ ...SUPABASE_FILES, "f.json": FIREBASE_USERS }))
      writeFileSync(join(dir, name), text, { mode: 0o600 });
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    db = await freshDatabase();
    await applyPostgresMigrations(db.sql);
  });
  afterEach(async () => {
    await db.drop();
  });

  /**
   * Runs `authtempo import` in the export folder. The compose password
   * `tempo` is a part of `authtempo`, and the scrub of spec 19 writes
   * `auth***` for it in every line. So the URL carries no password, and the
   * driver reads it from PGPASSWORD (as test/import-gate.test.ts does).
   */
  const importRun = (args: readonly string[]) => {
    const u = new URL(db.url);
    const password = decodeURIComponent(u.password);
    u.password = "";
    return runBin(["import", ...args, ...PG], {
      cwd: dir,
      env: { TEST_DB_URL: u.href, PGPASSWORD: password },
    });
  };

  /** The row count of a core table. */
  async function count(table: "ta_user" | "ta_password" | "ta_identity"): Promise<number> {
    const rows = await db.sql.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${table}`);
    return Number(rows[0]?.n);
  }

  /** A user row as an app or an earlier import run wrote it. */
  const userRow = (id: string, at: Date) => ({
    id,
    email: "ada@example.com",
    emailVerified: true,
    name: "Ada Lovelace",
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    username: null,
    displayUsername: null,
    phone: null,
    isAnonymous: false,
    createdAt: at,
    updatedAt: at,
  });

  it("imports into core's tables, prints the report, and exits 1 because two hashes were refused", async () => {
    const r = importRun([...SUPABASE, "--formats", ALL]);
    expect(r.status, r.stderr).toBe(1);
    const out = linesOf(r.stdout);
    expect(out[0]).toBe("supabase");
    const c = SUPABASE_FIXTURE_CREATED;
    expect(out).toContain(
      `created: user ${c.user}, identity ${c.identity}, password ${c.password}, passkey 0, organization 0, member 0`,
    );
    expect(out.filter((l) => l.startsWith("refused hash "))).toHaveLength(2);
    expect(linesOf(r.stderr)).toEqual([expect.stringMatching(/^connecting to \S+:\d+\/cli_/)]);
    expect(await count("ta_user")).toBe(c.user);
    expect(await count("ta_identity")).toBe(c.identity);
    expect(await count("ta_password")).toBe(c.password);
  });

  it("takes --formats none as the empty list: every hash is refused and listed", async () => {
    const r = importRun([...SUPABASE, "--formats", "none"]);
    expect(r.status, r.stderr).toBe(1);
    // The fixture holds four hashes. The run with every format refuses two (an
    // fbscrypt row of no known project and an argon2i string). With none, the
    // two bcrypt hashes are refused too.
    expect(linesOf(r.stdout).filter((l) => l.startsWith("refused hash "))).toHaveLength(4);
    expect(await count("ta_user")).toBe(SUPABASE_FIXTURE_CREATED.user);
    expect(await count("ta_password")).toBe(0);
  });

  it("stops with exit 2 on a taken address under --on-email-taken fail, and writes the report file", async () => {
    await createPostgresAdapter(db.sql).create("user", userRow("app", new Date()));
    const r = importRun([
      ...SUPABASE,
      "--formats",
      ALL,
      "--on-email-taken",
      "fail",
      "--report",
      "r.json",
    ]);
    expect(r.status, r.stderr).toBe(2);
    expect(linesOf(r.stderr).at(-1)).toMatch(/^stopped: .*email_taken for source record 11111111/);
    const file = join(dir, "r.json");
    const report = JSON.parse(readFileSync(file, "utf8"));
    expect(report.stopped).toMatch(/email_taken for source record 11111111/);
    expect(report.report).toMatchObject({ source: "supabase" });
    // The report file names each record, so only its owner can read it.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // The stop is at the first record, so the user of the app is the only one.
    expect(await count("ta_user")).toBe(1);
  });

  it("passes --repair: a half record gets its rows, and the report lists them", async () => {
    // The user row of Ada with her import id and no other row: a run that
    // stopped after the user row leaves this.
    await createPostgresAdapter(db.sql).create(
      "user",
      userRow(await importId("user", "supabase", ADA), new Date("2024-01-15T10:29:00.500Z")),
    );
    const plain = importRun([...SUPABASE, "--formats", ALL]);
    expect(linesOf(plain.stdout)).toContain(
      `partial user ${ADA}: missing identity:email, identity:google, password`,
    );
    expect(plain.status, plain.stderr).toBe(1);
    const fixed = importRun([...SUPABASE, "--formats", ALL, "--repair"]);
    const out = linesOf(fixed.stdout);
    expect(out).toContain(`repaired user ${ADA}: identity:email, identity:google, password`);
    expect(out.some((l) => l.startsWith("partial "))).toBe(false);
    expect(await count("ta_password")).toBe(SUPABASE_FIXTURE_CREATED.password);
  });

  it("firebase: the export and the project's rounds and mem_cost give the stored hash", async () => {
    const r = importRun([
      "firebase",
      "--users",
      "f.json",
      "--firebase-rounds",
      "8",
      "--firebase-mem-cost",
      "14",
      "--formats",
      "firescrypt",
    ]);
    expect(r.status, r.stderr).toBe(0);
    const [pw] = await createPostgresAdapter(db.sql).findMany("password", []);
    expect(pw?.hash).toBe(FIRESCRYPT);
  });
});
