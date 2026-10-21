import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SQLITE_MIGRATIONS } from "../src/migrations.js";

const D1_DIR = fileURLToPath(new URL("../../adapter-d1/migrations/", import.meta.url));
const GENERATED = fileURLToPath(new URL("../src/migrations.generated.ts", import.meta.url));

const d1Files = readdirSync(D1_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("the SQLite migrations (plan 12g)", () => {
  it("holds every D1 file byte for byte", () => {
    expect(d1Files.length).toBeGreaterThan(0);
    for (const [i, file] of d1Files.entries()) {
      const entry = SQLITE_MIGRATIONS[i];
      expect(entry?.name, file).toBe(file.slice(0, -".sql".length));
      expect(entry?.sql === readFileSync(`${D1_DIR}${file}`, "utf8"), `${file} differs`).toBe(true);
    }
    expect(SQLITE_MIGRATIONS.map((m) => m.name)).toEqual(d1Files.map((f) => f.slice(0, -4)));
  });

  it("is newer than the D1 folder", () => {
    const newest = Math.max(...d1Files.map((f) => statSync(`${D1_DIR}${f}`).mtimeMs));
    const built = statSync(GENERATED).mtimeMs;
    expect(
      built >= newest,
      "src/migrations.generated.ts is older than a D1 file: run the build",
    ).toBe(true);
  });
});
