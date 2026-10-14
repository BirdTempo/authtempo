import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryAdapter, type StorageAdapter, StorageError } from "@authtempo/core";
import { CONFLICT_REASONS, type ImportReport, importId } from "@authtempo/import";
import { LEGACY_FORMATS } from "@authtempo/legacy-hashes";
import { describe, expect, it } from "vitest";
// The fixtures stay with the readers in packages/import: plan 11c moved the CLI, not the readers.
import { SUPABASE_FIXTURE_CREATED } from "../../import/test/fixtures/supabase-counts.js";
import identities from "../../import/test/fixtures/supabase-identities.csv?raw";
import users from "../../import/test/fixtures/supabase-users.csv?raw";
import { FIRESCRYPT } from "../../import/test/readers/all.js";
import {
  type CliIo,
  exitCode,
  nodeImportIo,
  runCli,
  scrubbedIo,
  USAGE,
  writePrivate,
} from "../src/commands/import-alias.js";
import { ADMIN_URL } from "./support/pg.js";

/** Every format: the tests below that do not test --formats pass all five. */
const ALL = LEGACY_FORMATS.join(",");

function io(files: Record<string, string>, storage: StorageAdapter = createMemoryAdapter()) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const opened: { url: string; betterAuth: boolean }[] = [];
  const reads: string[] = [];
  const value: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readFile: (p) => {
      reads.push(p);
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT: ${p}`);
      return f;
    },
    writeFile: (p, t) => {
      written[p] = t;
    },
    openStorage: async (url, betterAuth) => {
      opened.push({ url, betterAuth });
      return { storage, close: async () => {} };
    },
  };
  return { value, out, err, written, opened, reads, storage };
}

const FILES = { "u.csv": users, "i.csv": identities };
const BASE = [
  "supabase",
  "--users",
  "u.csv",
  "--identities",
  "i.csv",
  "--postgres",
  "postgres://x",
  "--formats",
  ALL,
];

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
const CLERK = [
  "clerk",
  "--csv",
  "c.csv",
  "--users",
  "u.json",
  "--postgres",
  "postgres://x",
  "--formats",
  ALL,
];

function report(over: Partial<ImportReport>): ImportReport {
  return {
    source: "clerk",
    dryRun: false,
    created: { user: 0, identity: 0, password: 0, passkey: 0, organization: 0, member: 0 },
    exists: { user: 0, organization: 0 },
    skipped: [],
    refusedHashes: [],
    dropped: [],
    refusals: 0,
    partial: [],
    repaired: [],
    ...over,
  };
}

describe("authtempo-import", () => {
  it("imports, prints the report, and exits 1 because two hashes were refused", async () => {
    const t = io(FILES);
    expect(await runCli(BASE, t.value)).toBe(1);
    expect(t.out[0]).toBe("supabase");
    const c = SUPABASE_FIXTURE_CREATED;
    expect(t.out).toContain(
      `created: user ${c.user}, identity ${c.identity}, password ${c.password}, passkey 0, organization 0, member 0`,
    );
    expect(t.out.filter((l) => l.startsWith("refused hash ")).length).toBe(2);
    expect(t.opened).toEqual([{ url: "postgres://x", betterAuth: false }]);
  });

  it("exits 0 when nothing is refused and nothing conflicts", async () => {
    const clean = users.split("\n").slice(0, 3).join("\n");
    const t = io({ "u.csv": clean, "i.csv": identities });
    expect(await runCli(BASE, t.value)).toBe(0);
  });

  it("writes nothing on --dry-run and says so", async () => {
    const t = io(FILES);
    await runCli([...BASE, "--dry-run"], t.value);
    expect(t.out[0]).toBe("supabase (dry run, nothing written)");
    expect(await t.storage.findMany("user", [])).toEqual([]);
  });

  it("stops with exit 2 on a taken address under --on-email-taken fail", async () => {
    const storage = createMemoryAdapter();
    const at = new Date();
    await storage.create("user", {
      id: "app",
      email: "ada@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: at,
      updatedAt: at,
    });
    const t = io(FILES, storage);
    expect(await runCli([...BASE, "--on-email-taken", "fail"], t.value)).toBe(2);
    expect(t.err.at(-1)).toMatch(/email_taken for source record 11111111/);
  });

  it("writes the D1 bundle and opens no storage", async () => {
    const t = io(FILES);
    expect(
      await runCli(
        [
          "supabase",
          "--users",
          "u.csv",
          "--identities",
          "i.csv",
          "--d1-bundle",
          "b.json",
          "--legacy-verify",
          "--reserved-slugs",
          "billing,help",
          "--platform-slug",
          "staff",
          "--formats",
          "bcrypt,argon2id",
        ],
        t.value,
      ),
    ).toBe(0);
    const b = JSON.parse(t.written["b.json"] ?? "{}");
    expect(b.bundle).toMatchObject({ provider: "supabase", files: { users, identities } });
    expect(b.options).toMatchObject({
      legacyVerify: true,
      onEmailTaken: "skip",
      dryRun: false,
      reservedSlugs: ["billing", "help"],
      platformSlug: "staff",
      formats: ["bcrypt", "argon2id"],
    });
    expect(t.opened).toEqual([]);
  });

  it("refuses a usage error with exit 2 and the usage text", async () => {
    for (const argv of [
      ["nope", "--users", "u.csv", "--postgres", "x"],
      ["supabase", "--users", "u.csv", "--postgres", "x"],
      ["supabase", "--users", "u.csv", "--identities", "i.csv"],
      [
        "supabase",
        "--users",
        "u.csv",
        "--identities",
        "i.csv",
        "--postgres",
        "x",
        "--d1-bundle",
        "b",
      ],
      [
        "supabase",
        "--users",
        "u.csv",
        "--identities",
        "i.csv",
        "--hashes",
        "u.csv",
        "--postgres",
        "x",
      ],
      [...BASE, "--on-email-taken", "merge"],
      [...BASE, "--formats", "md5"],
      [...BASE, "--role-map", "billing=boss"],
      [...BASE, "--unknown-flag"],
      [...BASE, "--firebase-rounds", "8"],
      [...BASE, "--firebase-signer-key", "k"],
      [...BASE, "--password-column", "pw"],
      [...BASE, "--reserved-slugs", ""],
      [...BASE, "--platform-slug", "Not A Slug!"],
      ["supabase", "--users", "missing.csv", "--postgres", "x"],
    ]) {
      const t = io(FILES);
      expect(await runCli(argv, t.value), argv.join(" ")).toBe(2);
      expect(t.err.at(-1)).toMatch(/^authtempo-import <provider>/);
      expect(t.opened).toEqual([]);
      // Every flag check runs before the first file read (review M-1).
      expect(t.reads, argv.join(" ")).toEqual([]);
    }
  });

  it("exits 1 on a refusal: an organization slug in --reserved-slugs", async () => {
    const t = io({ "c.csv": CLERK_CSV, "u.json": CLERK_USERS, "o.json": clerkOrg("billing") });
    const code = await runCli(
      [...CLERK, "--organizations", "o.json", "--reserved-slugs", "billing"],
      t.value,
    );
    expect(t.out).toContain("skipped organization org_1: reserved_slug");
    expect(t.out).toContain("refusals: 1");
    expect(code).toBe(1);
  });

  it("passes --platform-slug: an organization cannot take the platform slug", async () => {
    const t = io({ "c.csv": CLERK_CSV, "u.json": CLERK_USERS, "o.json": clerkOrg("staff") });
    const code = await runCli(
      [...CLERK, "--organizations", "o.json", "--platform-slug", "staff"],
      t.value,
    );
    expect(t.out).toContain("skipped organization org_1: reserved_slug");
    expect(code).toBe(1);
  });

  it("stops with exit 2 before any write when a reader refuses a malformed file", async () => {
    // The Clerk reader reads organizations after it yields the users: without
    // the read-first pass, the users would be written before the error.
    const t = io({ "c.csv": CLERK_CSV, "u.json": CLERK_USERS, "o.json": "{}" });
    expect(
      await runCli([...CLERK, "--organizations", "o.json", "--report", "r.json"], t.value),
    ).toBe(2);
    expect(t.err).toHaveLength(1);
    expect(t.err[0]).toMatch(
      /^stopped: .*Clerk organizations input is not a JSON array.*; nothing was written$/,
    );
    expect(t.opened).toEqual([]);
    expect(await t.storage.findMany("user", [])).toEqual([]);
    // The report file says the run stopped, so an older file cannot pass for this run.
    expect(JSON.parse(t.written["r.json"] ?? "{}")).toMatchObject({ report: null });
    expect(JSON.parse(t.written["r.json"] ?? "{}").stopped).toMatch(/Clerk organizations/);
  });

  it("stops with exit 2 before storage opens on an out-of-bounds Firebase hashConfig", async () => {
    const t = io({ "f.json": JSON.stringify({ users: [] }) });
    const argv = [
      "firebase",
      "--users",
      "f.json",
      "--firebase-rounds",
      "8",
      "--firebase-mem-cost",
      "99",
      "--postgres",
      "x",
      "--formats",
      "firescrypt",
    ];
    expect(await runCli(argv, t.value)).toBe(2);
    expect(t.err).toEqual([
      expect.stringMatching(/^stopped: .*firebase hashConfig rounds and memCost/),
    ]);
    expect(t.opened).toEqual([]);
  });

  it("prints one stopped line and writes the report on a storage error", async () => {
    const t = io(FILES);
    t.value.openStorage = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5439"), {
        code: "ECONNREFUSED",
      });
    };
    expect(await runCli([...BASE, "--report", "r.json"], t.value)).toBe(2);
    // The driver's text is not printed (spec 19): the code and the host only.
    expect(t.err).toEqual(["stopped: storage: ECONNREFUSED at x; nothing was written"]);
    expect(JSON.parse(t.written["r.json"] ?? "{}")).toMatchObject({ report: null });

    // "storage:" only for a StorageError; any other error is the importer's own.
    const mid = io(FILES);
    mid.storage.transaction = async () => {
      throw new StorageError("schema_mismatch", "user");
    };
    expect(await runCli(BASE, mid.value)).toBe(2);
    expect(mid.err).toEqual([
      "stopped: storage: schema_mismatch on user; records before it may be written; run again",
    ]);
    const other = io(FILES);
    other.storage.transaction = async () => {
      throw new Error("terminating connection");
    };
    expect(await runCli(BASE, other.value)).toBe(2);
    expect(other.err).toEqual([
      "stopped: import: terminating connection; records before it may be written; run again",
    ]);
  });

  it("scrubs the --postgres value and its password from every line, also from a driver error that echoes them", async () => {
    const url = "postgres://app:s3cret-canary@db.example.com:5432/app";
    for (const form of [["--postgres", url], [`--postgres=${url}`]]) {
      const argv = [...BASE.filter((a) => a !== "--postgres" && a !== "postgres://x"), ...form];
      const t = io(FILES);
      t.storage.transaction = async () => {
        throw new Error(`password authentication failed: app:s3cret-canary at ${url}`);
      };
      expect(await runCli(argv, scrubbedIo(argv, t.value))).toBe(2);
      expect(t.err.at(-1)).toBe(
        "stopped: import: password authentication failed: *** at ***; records before it may be written; run again",
      );
      for (const line of [...t.out, ...t.err]) expect(line).not.toContain("s3cret-canary");
    }
  });

  it("pings in the real openStorage: a failed sign-in prints the SQLSTATE and the host, never the user", async () => {
    const url = ADMIN_URL.replace(/\/\/[^@]+@/, "//no_such_user_canary:wrong-pass-canary@");
    const argv = [
      ...BASE.filter((a) => a !== "--postgres" && a !== "postgres://x"),
      "--postgres",
      url,
    ];
    const t = io(FILES);
    const real: CliIo = { ...t.value, openStorage: nodeImportIo.openStorage };
    expect(await runCli(argv, scrubbedIo(argv, real))).toBe(2);
    const host = new URL(url);
    expect(t.err).toEqual([
      `stopped: storage: 28P01 at ${host.hostname}:${host.port}${host.pathname}; nothing was written`,
    ]);
    for (const line of [...t.out, ...t.err]) expect(line).not.toContain("canary");
  });

  it("refuses firebase with no --firebase-rounds: exit 2, the usage text, no file read", async () => {
    const t = io({ "f.json": JSON.stringify({ users: [] }) });
    for (const argv of [
      ["firebase", "--users", "f.json", "--firebase-mem-cost", "14"],
      ["firebase", "--users", "f.json", "--firebase-rounds", "8"],
    ]) {
      expect(await runCli([...argv, "--postgres", "x", "--formats", "firescrypt"], t.value)).toBe(
        2,
      );
      expect(t.err.at(-2)).toBe("firebase needs --firebase-rounds and --firebase-mem-cost");
      expect(t.err.at(-1)).toMatch(/^authtempo-import <provider>/);
    }
    expect(t.reads).toEqual([]);
  });

  it("refuses a provider with no --formats: exit 2, the usage text, no file read", async () => {
    // Spec 17.1: only the operator knows the seam's list, so there is no default.
    const t = io(FILES);
    const noFormats = BASE.slice(0, BASE.indexOf("--formats"));
    expect(await runCli(noFormats, t.value)).toBe(2);
    expect(t.err[0]).toBe(
      "supabase needs --formats: the formats list of the app's createLegacyPasswordHash, or none",
    );
    expect(t.err.at(-1)).toMatch(/^authtempo-import <provider>/);
    expect(t.reads).toEqual([]);
    expect(t.opened).toEqual([]);
  });

  it("takes --formats none as the empty list: every hash is refused and listed", async () => {
    const t = io(FILES);
    const none = [...BASE.slice(0, BASE.indexOf("--formats")), "--formats", "none"];
    expect(await runCli(none, t.value)).toBe(1);
    expect(await t.storage.findMany("password", [])).toEqual([]);
    // The fixture holds four hashes. The run with every format refuses two (an
    // fbscrypt row of no known project and an argon2i string). With none, the
    // two bcrypt hashes are refused too.
    expect(t.out.filter((l) => l.startsWith("refused hash ")).length).toBe(4);
  });

  it("writes the report file on a conflict stop", async () => {
    const storage = createMemoryAdapter();
    const at = new Date();
    await storage.create("user", {
      id: "app",
      email: "ada@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: at,
      updatedAt: at,
    });
    const t = io(FILES, storage);
    const argv = [...BASE, "--on-email-taken", "fail", "--report", "r.json"];
    expect(await runCli(argv, t.value)).toBe(2);
    const r = JSON.parse(t.written["r.json"] ?? "{}");
    expect(r.stopped).toMatch(/email_taken for source record 11111111/);
    expect(r.report).toMatchObject({ source: "supabase" });
  });

  it("exits 0 on a Supabase SSO user, and the report lists it", async () => {
    const rows = users.split("\n");
    const sso = rows.find((l) => l.startsWith("aaaaaaaa-"));
    expect(sso).toBeDefined();
    const t = io({ "u.csv": [...rows.slice(0, 3), sso].join("\n"), "i.csv": identities });
    expect(await runCli(BASE, t.value)).toBe(0);
    expect(t.out).toContain("skipped user aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa: sso_user");
    expect(t.out).toContain("refusals: 0");
  });

  it("exits 1 on a partial record and on every conflict reason, and 0 on a policy skip", () => {
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

  it("passes --repair: a half record gets its rows, and the report lists them", async () => {
    const db = createMemoryAdapter();
    const ada = "11111111-1111-4111-8111-111111111111";
    await db.create("user", {
      id: await importId("user", "supabase", ada),
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
      image: null,
      createdAt: new Date("2024-01-15T10:29:00.500Z"),
      updatedAt: new Date("2024-01-15T10:29:00.500Z"),
    });
    const plain = io(FILES, db);
    await runCli(BASE, plain.value);
    expect(plain.out).toContain(
      `partial user ${ada}: missing identity:email, identity:google, password`,
    );
    const fixed = io(FILES, db);
    await runCli([...BASE, "--repair"], fixed.value);
    expect(fixed.out).toContain(`repaired user ${ada}: identity:email, identity:google, password`);
    expect(fixed.out.some((l) => l.startsWith("partial "))).toBe(false);
    expect(USAGE).toContain("--repair");
  });

  it("writes the bundle and the report file with mode 0600, also over a wider file", () => {
    const dir = mkdtempSync(join(tmpdir(), "authtempo-cli-"));
    try {
      const path = join(dir, "bundle.json");
      writeFileSync(path, "old", { mode: 0o644 });
      writePrivate(path, "secret");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toBe("secret");
      writePrivate(join(dir, "new.json"), "x");
      expect(statSync(join(dir, "new.json")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("each provider's inputs reach its reader", () => {
    it("clerk: the CSV and the API JSON", async () => {
      const t = io({ "c.csv": CLERK_CSV, "u.json": CLERK_USERS });
      expect(await runCli(CLERK, t.value)).toBe(0);
      expect(t.out).toContain(
        "created: user 1, identity 1, password 1, passkey 0, organization 0, member 0",
      );
    });

    it("auth0: the users NDJSON and the hash file", async () => {
      const t = io({
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
      });
      const argv = [
        "auth0",
        "--users",
        "u.ndjson",
        "--hashes",
        "h.ndjson",
        "--postgres",
        "x",
        "--formats",
        "bcrypt",
      ];
      expect(await runCli(argv, t.value)).toBe(0);
      expect(t.out).toContain(
        "created: user 1, identity 1, password 1, passkey 0, organization 0, member 0",
      );
    });

    it("firebase: the export and the project's rounds and mem_cost", async () => {
      const t = io({
        "f.json": JSON.stringify({
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
        }),
      });
      const argv = [
        "firebase",
        "--users",
        "f.json",
        "--firebase-rounds",
        "8",
        "--firebase-mem-cost",
        "14",
        "--postgres",
        "x",
        "--formats",
        "firescrypt",
      ];
      expect(await runCli(argv, t.value)).toBe(0);
      const [pw] = await t.storage.findMany("password", []);
      expect(pw?.hash).toBe(FIRESCRYPT);
    });

    it("authjs: the tables, the password column, and the same relying party id", async () => {
      const t = io({
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
      });
      const argv = [
        "authjs",
        "--tables",
        "t.json",
        "--password-column",
        "pw",
        "--same-passkey-rp-id",
        "--postgres",
        "x",
        "--formats",
        "bcrypt",
      ];
      expect(await runCli(argv, t.value)).toBe(0);
      expect(t.out).toContain(
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
      const argv = ["cognito", "--users", "c.json", "--postgres", "x"];
      const on = io(files);
      expect(await runCli([...argv, "--legacy-verify"], on.value)).toBe(0);
      expect(on.out).toContain(
        "created: user 1, identity 1, password 1, passkey 0, organization 0, member 0",
      );
      const off = io(files);
      expect(await runCli(argv, off.value)).toBe(1);
    });

    it("cognito: a bare Users array (list-users --query Users) stops with exit 2, nothing written", async () => {
      const t = io({ "c.json": "[]" });
      const argv = ["cognito", "--users", "c.json", "--postgres", "x", "--legacy-verify"];
      expect(await runCli(argv, t.value)).toBe(2);
      expect(t.err).toEqual([
        expect.stringMatching(
          /^stopped: authtempo import: the Cognito users input has no Users array.*; nothing was written$/,
        ),
      ]);
      expect(t.opened).toEqual([]);
    });
  });
});
