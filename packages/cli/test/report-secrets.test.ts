import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_EXPORTS, type FixtureExport } from "@authtempo/import/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertFreshBuild, runBin } from "./support/bin.js";
import { freshDatabase } from "./support/pg.js";

// The no-secret rule of the report (plan 11f Task 4; spec 23 item 14). No
// output of `import` or `import verify` holds a hash, an address, or a name
// of the export. Each provider's fixture of `@authtempo/import/testing` names
// its secrets, and each runs as a child process on a fresh database that a
// real `authtempo migrate` made.

/** The flag of each file of a bundle, as `authtempo import` names it. */
const FLAG: Readonly<Record<string, string>> = {
  users: "--users",
  identities: "--identities",
  csv: "--csv",
  hashes: "--hashes",
  organizations: "--organizations",
  memberships: "--memberships",
  tables: "--authjs-tables",
};

let dir: string;

beforeAll(() => {
  assertFreshBuild();
  dir = mkdtempSync(join(tmpdir(), "authtempo-secrets-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes the files of a fixture, and answers the arguments of its import after the provider. */
function argsOf(provider: string, f: FixtureExport): string[] {
  const folder = join(dir, provider);
  mkdirSync(folder);
  const args: string[] = [];
  for (const [name, text] of Object.entries(f.bundle.files)) {
    const flag = FLAG[name];
    if (flag === undefined || text === undefined)
      throw new Error(`${provider}: no flag for ${name}`);
    const path = join(folder, `${name}.txt`);
    writeFileSync(path, text, { mode: 0o600 });
    args.push(flag, path);
  }
  const fb = f.bundle.firebase;
  if (provider === "firebase" && fb !== undefined)
    args.push("--firebase-rounds", String(fb.rounds), "--firebase-mem-cost", String(fb.memCost));
  if (f.bundle.passwordColumn !== undefined)
    args.push("--password-column", f.bundle.passwordColumn);
  if (f.bundle.samePasskeyRpId) args.push("--same-passkey-rp-id");
  args.push("--formats", f.formats.length > 0 ? f.formats.join(",") : "none");
  if (f.legacyVerify) args.push("--legacy-verify");
  return args;
}

it("prints no hash, address, or name of any provider's export", async () => {
  const providers = Object.entries(FIXTURE_EXPORTS);
  expect(providers.length).toBeGreaterThanOrEqual(7);
  for (const [provider, f] of providers) {
    const db = await freshDatabase();
    try {
      const u = new URL(db.url);
      const password = decodeURIComponent(u.password);
      u.password = "";
      const env = { TEST_DB_URL: u.href, PGPASSWORD: password };
      const m = runBin(["migrate", "--target", "postgres", "--url-env", "TEST_DB_URL"], { env });
      expect(m.status, `${provider}: ${m.stderr}`).toBe(0);
      const args = argsOf(provider, f);
      // The import first, then the verify: a failure names the run and the output.
      for (const [name, head, file] of [
        ["import", ["import", provider], join(dir, provider, "r.json")],
        ["verify", ["import", "verify", provider], join(dir, provider, "v.json")],
      ] as const) {
        const r = runBin([...head, ...args, ...PG, "--report", file, "--json"], { env });
        expect(r.status, `${provider} ${name}: ${r.stderr}`).toBe(0);
        const outputs = { stdout: r.stdout, stderr: r.stderr, report: readFileSync(file, "utf8") };
        expect(f.secrets.length, provider).toBeGreaterThan(0);
        for (const secret of f.secrets)
          for (const [where, text] of Object.entries(outputs))
            expect(text, `${provider} ${name}: ${where} holds a secret`).not.toContain(secret);
      }
    } finally {
      await db.drop();
    }
  }
});

const PG = ["--target", "postgres", "--url-env", "TEST_DB_URL"];
