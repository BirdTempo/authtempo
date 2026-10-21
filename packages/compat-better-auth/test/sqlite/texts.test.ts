import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compatSqliteSteps } from "../../src/storage/migration.js";
import { resolveNames } from "../../src/storage/names.js";

/**
 * A SQL text with its comment lines dropped and each run of white space
 * outside quotes made one space. A shipped file has a comment header, and a
 * shipped file never changes, so the compare cannot be byte for byte (plan
 * 12g Task 8). The rule of migration-file.test.ts also collapses white space
 * inside quotes. This rule keeps quoted text as it is, so a change of a
 * quoted value fails the test too (ruling 12 of plan 12g).
 */
const normalize = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(/('(?:[^']|'')*'|"(?:[^"]|"")*")/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\s+/g, " ")))
    .join("")
    .trim();

it("holds each SQLite text of the default names to the shipped D1 file of its name and variant", () => {
  for (const [variant, dir] of [
    ["1.7", "d1"],
    ["before-1.7", "d1-before-1.7"],
  ] as const) {
    const folder = new URL(`../../migrations/${dir}/`, import.meta.url);
    const steps = compatSqliteSteps(resolveNames(), variant);
    expect(steps.map((m) => `${m.name}.sql`)).toEqual(readdirSync(folder).sort());
    for (const m of steps)
      expect({ dir, name: m.name, text: normalize(m.text) }).toEqual({
        dir,
        name: m.name,
        text: normalize(readFileSync(new URL(`${m.name}.sql`, folder), "utf8")),
      });
  }
});
