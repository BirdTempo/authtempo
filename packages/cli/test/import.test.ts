import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_FORMATS } from "@authtempo/legacy-hashes";
import { describe, expect, it } from "vitest";
import { IMPORT_JSON_KEYS } from "../src/json.js";
import { main } from "../src/main.js";
import { PKG } from "./support/bin.js";
import { fakeIo } from "./support/fake-io.js";

const FIXTURES = join(PKG, "../import/test/fixtures");
const FILES = {
  "/work/u.csv": readFileSync(join(FIXTURES, "supabase-users.csv"), "utf8"),
  "/work/i.csv": readFileSync(join(FIXTURES, "supabase-identities.csv"), "utf8"),
  "/work/tables.json": JSON.stringify({ users: [], accounts: [], authenticators: [] }),
};
const ALL = LEGACY_FORMATS.join(",");
const SUPABASE = [
  "import",
  "supabase",
  "--users",
  "u.csv",
  "--identities",
  "i.csv",
  "--formats",
  ALL,
];

async function run(args: string[], o: Parameters<typeof fakeIo>[0] = {}) {
  const io = fakeIo({ files: FILES, ...o });
  const code = await main(args, io);
  return { code, io };
}

describe("authtempo import (spec 19, the flag map)", () => {
  it("refuses each old flag with its new form, before any file read", async () => {
    const cases: [string[], string][] = [
      [
        ["--postgres", "postgres://x"],
        "authtempo import takes no --postgres: use --target postgres with --url-env <NAME> or --url-file <path>, so the connection string stays out of the command line",
      ],
      [["--better-auth"], "authtempo import takes no --better-auth: use --tables compat"],
      [
        ["--d1-bundle=b.json"],
        "authtempo import takes no --d1-bundle: use --target d1-bundle --out <file>",
      ],
      [
        ["--firebase-signer-key", "k"],
        "authtempo import takes no --firebase-signer-key: use --firebase-signer-key-env <NAME> or --firebase-signer-key-file <path>",
      ],
    ];
    for (const [extra, message] of cases) {
      const { code, io } = await run([...SUPABASE, ...extra]);
      expect(code).toBe(2);
      expect(io.stderr[0]).toBe(message);
      expect(io.reads).toEqual([]);
    }
  });

  it("names --authjs-tables when --tables gets a file", async () => {
    const { code, io } = await run([
      "import",
      "authjs",
      "--tables",
      "tables.json",
      "--formats",
      "bcrypt",
      "--target",
      "d1-bundle",
      "--out",
      "b.json",
    ]);
    expect(code).toBe(2);
    expect(io.stderr[0]).toBe(
      "--tables names the table set, core or compat; an Auth.js export is --authjs-tables <file>",
    );
  });

  it("writes the D1 bundle with --target d1-bundle --out, and opens no database", async () => {
    const { code, io } = await run([...SUPABASE, "--target", "d1-bundle", "--out", "b.json"]);
    expect(code).toBe(0);
    expect(io.stdout).toEqual([
      "wrote b.json; run the D1 Worker script (packages/import/worker/README.md)",
    ]);
    const written = JSON.parse(io.files.get("/work/b.json") ?? "") as {
      bundle: { provider: string };
    };
    expect(written.bundle.provider).toBe("supabase");
  });

  it("prints one JSON document with --json, and the human lines go to stderr", async () => {
    const { code, io } = await run([
      ...SUPABASE,
      "--target",
      "d1-bundle",
      "--out",
      "b.json",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(io.stdout).toHaveLength(1);
    const doc = JSON.parse(io.stdout[0] ?? "") as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(IMPORT_JSON_KEYS).sort());
    expect(doc).toEqual({ report: null, stopped: null, bundle: "b.json", verify: null, exit: 0 });
    expect(io.stderr).toContain(
      "wrote b.json; run the D1 Worker script (packages/import/worker/README.md)",
    );
  });

  it("passes --authjs-tables to the Auth.js reader as its tables file", async () => {
    const { code, io } = await run([
      "import",
      "authjs",
      "--authjs-tables",
      "tables.json",
      "--formats",
      "bcrypt",
      "--target",
      "d1-bundle",
      "--out",
      "b.json",
    ]);
    expect(code).toBe(0);
    const written = JSON.parse(io.files.get("/work/b.json") ?? "") as {
      bundle: { files: { tables?: string } };
    };
    expect(written.bundle.files.tables).toBe(FILES["/work/tables.json"]);
  });

  it("reads the Firebase signer key of a Supabase run from a variable, and prints it nowhere", async () => {
    const key = "s3cret-canary-signer-key";
    const { code, io } = await run(
      [
        ...SUPABASE,
        "--firebase-signer-key-env",
        "SIGNER",
        "--firebase-salt-separator",
        "Bw==",
        "--target",
        "d1-bundle",
        "--out",
        "b.json",
      ],
      { env: { SIGNER: key } },
    );
    expect(code).toBe(0);
    const written = JSON.parse(io.files.get("/work/b.json") ?? "") as {
      bundle: { firebase?: { signerKey: string } };
    };
    expect(written.bundle.firebase?.signerKey).toBe(key);
    for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain(key);
  });

  it("needs a target, a set connection string, and --out for a bundle, each before any file read", async () => {
    const cases: [string[], Record<string, string>, string][] = [
      [[], {}, "name a target: --target postgres, --target d1-bundle, or --target memory"],
      [
        ["--target", "postgres"],
        {},
        "set DATABASE_URL to the connection string, or give --url-env or --url-file",
      ],
      [
        ["--target", "postgres", "--url-env", "postgres://u:p@h/d"],
        {},
        "--url-env takes the name of a variable, not a value",
      ],
      [["--target", "d1-bundle"], {}, "--target d1-bundle needs --out <file>"],
      [
        ["--target", "d1-bundle", "--out", "b.json", "--tables", "compat"],
        {},
        "--tables compat needs --target postgres; on D1, set TARGET=compat on the import Worker",
      ],
      [
        ["--target", "postgres", "--out", "b.json"],
        { DATABASE_URL: "postgres://h/d" },
        "--out needs --target d1-bundle",
      ],
    ];
    for (const [extra, env, message] of cases) {
      const { code, io } = await run([...SUPABASE, ...extra], { env });
      expect(code, message).toBe(2);
      expect(io.stderr[0]).toBe(message);
      expect(io.reads).toEqual([]);
    }
  });

  it("reads no old flag after --: an argument there is a positional", async () => {
    const { code, io } = await run([
      ...SUPABASE,
      "--target",
      "d1-bundle",
      "--out",
      "b.json",
      "--",
      "--postgres=x",
    ]);
    expect(code).toBe(2);
    expect(io.stderr[0]).toMatch(/^name one provider: /);
    expect(io.reads).toEqual([]);
  });

  it("keeps the old checks with the new names: authjs needs --authjs-tables", async () => {
    const { code, io } = await run([
      "import",
      "authjs",
      "--formats",
      "bcrypt",
      "--target",
      "d1-bundle",
      "--out",
      "b.json",
    ]);
    expect(code).toBe(2);
    expect(io.stderr[0]).toBe("authjs needs --authjs-tables");
  });
});
