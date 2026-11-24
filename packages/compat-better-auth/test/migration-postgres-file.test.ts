import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPAT_MIGRATION_NAMES, compatPostgresSteps } from "../src/storage/migration.js";
import { resolveNames } from "../src/storage/names.js";

// The Postgres text of each compat migration with the default names, as a
// file of migrations/postgres/ (ruling 67 of plan 12j, Minor 2). The runner
// writes this text from code, so an edit of the code could change a shipped
// migration, and no check saw it. The files are records: check-records holds
// packages/*/migrations/**. This test holds each file to the runner byte for
// byte, as migration-file.test.ts holds the D1 files.
const DIR = new URL("../migrations/postgres/", import.meta.url);

describe("the Postgres files of the compat migrations", () => {
  it("hold the text of the runner for the default names, byte for byte", () => {
    const steps = compatPostgresSteps(resolveNames());
    expect(steps.map((s) => s.name)).toEqual([...COMPAT_MIGRATION_NAMES]);
    expect(readdirSync(DIR).sort()).toEqual(steps.map((s) => `${s.name}.sql`).sort());
    for (const s of steps)
      expect(readFileSync(new URL(`${s.name}.sql`, DIR), "utf8"), s.name).toBe(s.text);
  });
});

describe("the count of the compat migrations (plan 13b)", () => {
  // Plan 13b adds 0015 for core's schema version 18. Each of the three
  // folders ships one file for each name of the runner, and no other file.
  it("is fifteen names, and each folder holds one file for each name", () => {
    expect(COMPAT_MIGRATION_NAMES).toHaveLength(15);
    expect(COMPAT_MIGRATION_NAMES.at(-1)).toBe("0015_compat_schema_v18");
    for (const folder of ["d1", "d1-before-1.7", "postgres"]) {
      const files = readdirSync(new URL(`../migrations/${folder}/`, import.meta.url)).sort();
      expect({ folder, files }).toEqual({
        folder,
        files: COMPAT_MIGRATION_NAMES.map((name) => `${name}.sql`),
      });
    }
  });
});
