import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEALED_OR_HASH } from "../src/generate/header.js";
import { main } from "../src/main.js";
import { assertFreshBuild, linesOf, runBin } from "./support/bin.js";
import { fakeIo } from "./support/fake-io.js";

// `authtempo generate` (plan 12g Task 7): the command, its output, and the
// no-secret rule. The tests of each format are in generate-sql,
// generate-drizzle, and generate-prisma.

const FORMATS = ["sql", "drizzle", "prisma"];
const DIALECTS = ["sqlite", "postgres", "mysql"];
const RUNS = FORMATS.flatMap((f) => DIALECTS.map((d) => [f, d] as const));

let dir: string;
beforeAll(() => {
  assertFreshBuild();
});
beforeEach(() => {
  // The CLI resolves --out from its cwd, which is the folder with each link resolved.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-cli-generate-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("authtempo generate (plan 12g Task 7)", () => {
  it("prints to stdout and writes no file", () => {
    const r = runBin(["generate", "--format", "sql", "--dialect", "sqlite"], { cwd: dir });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.startsWith("-- authtempo schema version 13, dialect sqlite,")).toBe(true);
    expect(r.stdout).toContain("CREATE TABLE ta_user (");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes a new file with --out and stops on a file that exists", () => {
    const args = ["generate", "--format", "sql", "--dialect", "postgres", "--out", "schema.sql"];
    const first = runBin(args, { cwd: dir });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toBe("");
    const file = join(dir, "schema.sql");
    expect(linesOf(first.stderr)).toEqual([`wrote ${file}`]);
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("-- authtempo schema version 13, dialect postgres,")).toBe(true);

    const second = runBin(args, { cwd: dir });
    expect(second.status).toBe(2);
    expect(second.stdout).toBe("");
    expect(linesOf(second.stderr)).toEqual([
      `stopped: generate writes no file over a file; ${file} exists`,
    ]);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("refuses --dialect d1 and names sqlite", () => {
    const r = runBin(["generate", "--format", "sql", "--dialect", "d1"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(linesOf(r.stderr)[0]).toBe(
      "--dialect d1: use --dialect sqlite; a D1 app applies the files of @authtempo/adapter-d1 with wrangler",
    );
  });

  it("holds no secret of the environment", () => {
    const env = {
      DATABASE_URL: "postgres://app:url-canary-5c1e@db.example.com:5432/app",
      LIBSQL_AUTH_TOKEN: "token-canary-9a4d",
      AUTHTEMPO_OPERATOR_SECRET: "operator-canary-7b2f",
    };
    for (const [format, dialect] of RUNS)
      for (const json of [[], ["--json"]]) {
        const r = runBin(["generate", "--format", format, "--dialect", dialect, ...json], { env });
        expect(r.status, `${format} ${dialect} ${r.stderr}`).toBe(0);
        for (const value of [
          "url-canary-5c1e",
          "db.example.com",
          "token-canary-9a4d",
          "operator-canary-7b2f",
        ])
          expect(r.stdout + r.stderr, `${format} ${dialect}`).not.toContain(value);
      }
  });

  it("reads no network and no file", async () => {
    for (const [format, dialect] of RUNS) {
      const io = fakeIo({
        env: { DATABASE_URL: "postgres://app:pw@db.example.com/app" },
        fetch: () => {
          throw new Error("generate made a network call");
        },
      });
      io.readFile = () => {
        throw new Error("generate read a file");
      };
      io.run = () => {
        throw new Error("generate ran a child process");
      };
      expect(await main(["generate", "--format", format, "--dialect", dialect], io)).toBe(0);
      expect(io.stderr, `${format} ${dialect}`).toEqual([]);
      expect(io.stdout.length).toBeGreaterThan(100);
      expect(io.requests).toEqual([]);
    }
  });

  it("starts with the one header line", async () => {
    for (const [format, dialect] of RUNS) {
      const io = fakeIo();
      expect(await main(["generate", "--format", format, "--dialect", dialect], io)).toBe(0);
      const mark = format === "sql" ? "--" : "//";
      expect(io.stdout[0]).toBe(
        `${mark} authtempo schema version 13, dialect ${dialect}, authtempo CLI 0.0.0. authtempo owns these tables. Create and change them with \`authtempo migrate\`. Write rows through the engine only.`,
      );
      expect(io.stdout[1]).toBe(
        `${mark} This file is for reads. A write through the ORM skips the engine's guards: the claim rule, the conditional consume, and the undo of a user create.`,
      );
    }
  });

  it("prints the text in the --json document, and the path with --out", async () => {
    const io = fakeIo();
    expect(
      await main(["generate", "--format", "prisma", "--dialect", "sqlite", "--json"], io),
    ).toBe(0);
    expect(io.stdout).toHaveLength(1);
    const doc = JSON.parse(io.stdout[0] ?? "") as Record<string, unknown>;
    expect(doc).toMatchObject({
      format: "prisma",
      dialect: "sqlite",
      schemaVersion: 13,
      out: null,
      exit: 0,
      stopped: null,
    });
    expect(String(doc.text)).toContain("model TaUser {");

    const written = fakeIo();
    const argv = ["generate", "--format", "sql", "--dialect", "mysql", "--out", "a.sql", "--json"];
    expect(await main(argv, written)).toBe(0);
    expect(JSON.parse(written.stdout[0] ?? "")).toMatchObject({ out: "/work/a.sql", text: null });
    expect(written.files.get("/work/a.sql")).toContain("CREATE TABLE `ta_user` (");
  });

  it("marks each sealed field and each hash", () => {
    expect([...SEALED_OR_HASH].sort()).toEqual([
      "apiToken.tokenHash",
      "invitation.tokenHash",
      "jwk.privateKey",
      "oauthClient.previousSecretHash",
      "oauthClient.secretHash",
      "oauthDevice.deviceCodeHash",
      "oauthDevice.userCodeHash",
      "oauthToken.tokenHash",
      "organizationToken.tokenHash",
      "password.hash",
      "secondFactor.backupCodes",
      "session.tokenHash",
      "totp.backupCodes",
      "totp.secret",
      "trustedDevice.tokenHash",
      "verification.valueHash",
    ]);
  });
});
