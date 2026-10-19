import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PAGE = new URL("../src/content/docs/docs/migrate/cutover.md", import.meta.url);

/**
 * The 1.7.7 caution of spec 23 item 12. The cutover page starts its body with it,
 * right after the list of "Before you start" and before "Steps". This test holds the
 * page copy, as migrate-better-auth.test.ts holds the caution of the Better Auth guide.
 */
const CAUTION = [
  ":::caution",
  "Warning: on Better Auth below 1.7.7, upgrade to 1.7.7 or later before the move. Version 1.7.7 fixed a magic link takeover, and the old system stays the rollback target.",
  ":::",
] as const;

/** The step that stops the old sign-ins. The export after it holds every change up to the cutover. */
const STOP = "At the cutover, stop the sign-ins of the old system.";

/** Ruling 14 of plan 11f, M1: an import from the guide's first export loses each later change. */
const EXPORT_AGAIN =
  "With an import, export again from the old system by the commands of the guide. If not, each sign-up and each change after the first export is lost.";

/**
 * The dry run and the real run read the new export, so they come after it. Ruling 15
 * of plan 11f: this is the one real import into the real database.
 */
const RUN =
  "Run the import on the new export into the real database, first as a dry run and then for real. This is the one real import into it. With the compatibility package, deploy the alias instead.";

/** Ruling 15 of plan 11f: before the cutover, the real import runs on a copy only. */
const DRY_RUN =
  "Run the import as a dry run on the real database, and read every line of the report. Run the real import on a copy only, as the guide says. [One real import](#one-real-import) tells why.";

/** The start of step 10, the verify of the one real import. */
const VERIFY =
  "After an import, run [`authtempo import verify`](/docs/reference/cli/import/#verify)";

/** The order of "One real import". It names steps 7 to 10, so the steps test holds those numbers. */
const ORDER = [
  "1. Before the cutover, the guide runs the real import and `import verify` on a copy of the database. The real database stays empty.",
  "2. At step 7, the old sign-ins stop. After that, no person changes a password, an address, or an account in the old system.",
  "3. At step 8, the new export holds each change up to that moment.",
  "4. At step 9, the one real import writes the new export into the real database. At step 10, `import verify` reads it.",
] as const;

/** The final review of plan 11f, M1: a second import keeps each held user, and verify exits 0. */
const LIMIT =
  "A real database that holds an earlier import has this limit. The import writes nothing for a user that the database holds by its import id, and `--repair` writes only missing rows. So a password, an address, or a delete that changed in the old system after the earlier import is not carried. `import verify` does not see the change, because it reads that each row exists, not its text, and it exits 0. The old password of such a user still signs in, and the new one does not. The remedy: each user who changed the password after the earlier import resets it.";

/** Auth0 sends the hash file through a support case, so the cutover cannot export it again. */
const AUTH0 =
  "On Auth0, the hash file comes from a support case, so step 8 cannot export the hashes again. A password that changed after the hash export imports with its old hash, and that user resets the password too.";

/** Ruling 14 of plan 11f, M3: the Cognito check calls the pool until `legacyVerify` goes. */
const KEEP_UP =
  "Keep the old provider up until the old TTL has passed. With the Cognito check, keep the pool up until step 19. If the pool stops, each user who has not signed in yet loses the password sign-in.";

/** The step that the Cognito pool must outlive. */
const LAST =
  "Remove `password.legacyVerify` when the Cognito users have signed in, or when the migration window ends.";

/** The lines from the line `from` to the next heading, with the blank lines removed. */
function partAfter(from: string): string[] {
  const lines = readFileSync(PAGE, "utf8").split("\n");
  const start = lines.indexOf(from);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("#"));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.trim() !== "");
}

/** The numbered steps of "Steps", each without its number, after a check that the numbers run 1, 2, 3. */
function steps(): string[] {
  const items = partAfter("## Steps").filter((l) => /^\d+\. /.test(l));
  items.forEach((l, i) => {
    expect(l.startsWith(`${i + 1}. `)).toBe(true);
  });
  return items.map((l) => l.replace(/^\d+\. /, ""));
}

describe("the cutover page", () => {
  it("starts its body with the 1.7.7 caution, after the list of Before you start", () => {
    const before = partAfter("## Before you start");
    const list = before.slice(0, -CAUTION.length);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((l) => l.startsWith("- "))).toBe(true);
    expect(before.slice(-CAUTION.length)).toEqual([...CAUTION]);
  });

  it("exports again after the old sign-ins stop, before the dry run and the real run", () => {
    const list = steps();
    const stop = list.indexOf(STOP);
    expect(stop).toBeGreaterThan(-1);
    expect(list.slice(stop, stop + 3)).toEqual([STOP, EXPORT_AGAIN, RUN]);
  });

  it("runs the one real import at step 9, after the stop at step 7 and the export at step 8", () => {
    const list = steps();
    expect(list[3]).toBe(DRY_RUN);
    expect(list.slice(6, 9)).toEqual([STOP, EXPORT_AGAIN, RUN]);
    expect(list[9]?.startsWith(VERIFY)).toBe(true);
  });

  it("states the order of the one real import, and the limit of an earlier import", () => {
    const part = partAfter("## One real import");
    expect(part.filter((l) => /^\d+\. /.test(l))).toEqual([...ORDER]);
    expect(part).toContain(LIMIT);
    expect(part).toContain(AUTH0);
  });

  it("keeps the Cognito pool up until step 19, the removal of legacyVerify", () => {
    const list = steps();
    expect(list.indexOf(KEEP_UP)).toBeGreaterThan(-1);
    expect(list.indexOf(KEEP_UP)).toBeLessThan(18);
    expect(list.indexOf(LAST)).toBe(18);
  });
});
