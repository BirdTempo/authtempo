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
