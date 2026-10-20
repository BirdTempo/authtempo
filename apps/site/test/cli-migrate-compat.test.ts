import { readFileSync } from "node:fs";
import * as compat from "@authtempo/compat-better-auth";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

/** The two CLI pages that tell an app with other table names which compat files to write. */
const PAGES = {
  "reference/cli/migrate.md": `${DOCS}docs/reference/cli/migrate.md`,
  "packages/cli/README.md": `${REPO}packages/cli/README.md`,
} as const;

type Names = ReturnType<typeof compat.resolveNames>;

/** The number words that the pages use for a file count. */
const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

/** A whole number as a word, as the pages write it. */
function word(n: number): string {
  const w = WORDS[n];
  if (w === undefined) throw new Error(`no word for ${n}`);
  return w;
}

/** The SQLite text of one shipped compat file for a naming, or null when no export takes a naming. */
function sqlite(prefix: string, names: Names): string | null {
  if (prefix === "0001") return compat.compatMigrationSql("sqlite", names);
  const make = (compat as Record<string, unknown>)[`compatMigration${prefix}Sql`];
  if (typeof make !== "function") return null;
  return (make as (d: "sqlite", n: Names) => string)("sqlite", names);
}

/**
 * The shipped compat files whose text depends on the naming: the text for
 * other table and column names differs from the text for the default names.
 * The list comes from the package, so a new file of this kind fails the test
 * until both pages name it.
 */
function namingFiles(): string[] {
  const other = compat.resolveNames({
    casing: "snake",
    tables: {
      user: "users",
      session: "sessions",
      account: "accounts",
      verification: "verifications",
      passkey: "passkeys",
    },
  });
  return prefixes().filter((p) => {
    const own = sqlite(p, other);
    return own !== null && own !== sqlite(p, compat.resolveNames());
  });
}

/** The four-digit prefix of each shipped compat file, in order. */
function prefixes(): string[] {
  return compat.COMPAT_MIGRATION_NAMES.map((name) => name.slice(0, 4));
}

/** "0001, 0006, and 0007", as the pages list files. */
function list(items: readonly string[]): string {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

describe("the CLI pages on compat files for tables with other names", () => {
  const files = namingFiles();
  const count = compat.COMPAT_MIGRATION_NAMES.length;

  it("finds the files that depend on the naming", () => {
    // The package ships nine files, and four of them take the naming (plan 12f).
    expect(count).toBe(9);
    expect(files).toEqual(["0001", "0006", "0007", "0009"]);
  });

  for (const [name, path] of Object.entries(PAGES)) {
    describe(name, () => {
      const text = readFileSync(path, "utf8").replace(/\s+/g, " ");

      it("names each shipped file that fails on other names", () => {
        expect(text).toContain(`shipped ${list(files)} fail`);
      });

      it("names the function that writes each such file", () => {
        for (const p of files.filter((f) => f !== "0001")) {
          expect(text).toContain(`compatMigration${p}Sql("sqlite", storage.names)`);
        }
      });

      it("states the file count and the compat version after the own files", () => {
        expect(text).toContain(`writes its own ${word(count)} `);
        expect(text).toContain(`the compat version is ${count}, and the command copies nothing`);
      });
    });
  }
});
