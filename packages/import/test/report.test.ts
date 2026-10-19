import { createMemoryAdapter, LEGACY_VERIFY_HASH } from "@authtempo/core";
import { VECTORS } from "@authtempo/legacy-hashes/testing";
import { describe, expect, it } from "vitest";
import { importUsers } from "../src/import.js";
import { summary, verifyLine, verifyReport } from "../src/report.js";
import type { ImportRecord, ImportReport } from "../src/types.js";
import { BCRYPT, listSource, user } from "./source.js";

// The hash format counts of the report (plan 11f Task 3; spec 23 items 5 and
// 14). The report holds one count per user record of the export. The key is
// the format of its hash, the reader's refused tag, or `none`. The operator
// checks the line against `--formats` before the real run. The summary
// prints tags and counts only.

/**
 * Five users: a bcrypt hash, an argon2id hash, a reader refusal, no password,
 * and a deleted user with a bcrypt hash. The count runs before any skip rule,
 * so the deleted user counts too (review of plan 11f Task 3).
 */
const five = (): ImportRecord[] => [
  user("u1", { password: { hash: BCRYPT } }),
  user("u2", { password: { hash: VECTORS.argon2id.stored } }),
  user("u3", { password: { refused: "md5" } }),
  user("u4"),
  user("u5", { password: { hash: BCRYPT }, skip: "deleted" }),
];

const run = (records: ImportRecord[], legacyVerify = false) =>
  importUsers(createMemoryAdapter(), listSource(records), {
    formats: ["bcrypt", "argon2id"],
    legacyVerify,
  });

describe("ImportReport.hashFormats", () => {
  it("counts the hash format of each user, a skipped user too", async () => {
    const report = await run(five());
    expect(report.skipped).toEqual([{ kind: "user", sourceId: "u5", reason: "deleted" }]);
    expect(Object.entries(report.hashFormats)).toEqual([
      ["bcrypt", 2],
      ["argon2id", 1],
      ["md5", 1],
      ["none", 1],
    ]);
  });

  it("prints the hash line after the refusals line", async () => {
    const lines = summary(await run(five()));
    expect(lines[3]).toBe("refusals: 0");
    expect(lines[4]).toBe("hashes: bcrypt 2, argon2id 1, md5 1, none 1");
  });

  it("counts the Cognito marker by its name", async () => {
    const report = await run([user("u1", { password: { hash: LEGACY_VERIFY_HASH } })], true);
    expect(Object.entries(report.hashFormats)).toEqual([["legacy-verify", 1]]);
  });

  it("counts a refused tag named __proto__ as an own key", async () => {
    // A Clerk export names its hasher, so the tag comes from the export.
    const report = await run([user("u1", { password: { refused: "__proto__" } })]);
    expect(Object.hasOwn(report.hashFormats, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(report.hashFormats)).toBe(Object.prototype);
    expect(summary(report)[4]).toBe("hashes: __proto__ 1");
  });

  it("prints none when the export has no user", async () => {
    expect(summary(await run([]))[4]).toBe("hashes: none");
  });
});

// The verify rule of `authtempo import verify` and of a verify bundle on D1
// (plan 11f Task 4; spec 23 item 7). One pure function decides the exit
// status, and one line prints counts and no source id.

const NONE = { user: 0, identity: 0, password: 0, passkey: 0, organization: 0, member: 0 };

/** A dry-run report with two users that exist and nothing else. */
function dry(over: Partial<ImportReport> = {}): ImportReport {
  return {
    source: "supabase",
    dryRun: true,
    created: { ...NONE },
    exists: { user: 2, organization: 0 },
    skipped: [],
    refusedHashes: [],
    dropped: [],
    refusals: 0,
    hashFormats: { bcrypt: 2 },
    partial: [],
    repaired: [],
    ...over,
  };
}

describe("verifyReport", () => {
  it("holds the export only on a dry run with nothing to write and nothing to look at", () => {
    expect(verifyReport(dry())).toEqual({
      held: true,
      wouldWrite: 0,
      partial: 0,
      needPerson: 0,
      code: 0,
    });
    expect(verifyReport(dry({ created: { ...NONE, user: 1 } }))).toEqual({
      held: false,
      wouldWrite: 1,
      partial: 0,
      needPerson: 0,
      code: 1,
    });
    // An identity to write is not a record to write, but the database does not hold the export.
    expect(verifyReport(dry({ created: { ...NONE, identity: 1 } }))).toMatchObject({
      held: false,
      wouldWrite: 0,
      code: 1,
    });
    expect(
      verifyReport(dry({ partial: [{ kind: "user", sourceId: "u2", missing: ["password"] }] })),
    ).toEqual({ held: false, wouldWrite: 0, partial: 1, needPerson: 0, code: 1 });
    expect(
      verifyReport(dry({ skipped: [{ kind: "user", sourceId: "u3", reason: "email_taken" }] })),
    ).toEqual({ held: false, wouldWrite: 0, partial: 0, needPerson: 1, code: 1 });
    expect(
      verifyReport(
        dry({
          refusedHashes: [{ sourceId: "u4", format: "md5" }],
          skipped: [{ kind: "organization", sourceId: "o1", reason: "invalid_name" }],
          refusals: 1,
        }),
      ),
    ).toMatchObject({ held: false, needPerson: 2, code: 1 });
    expect(verifyReport(dry({ dryRun: false }))).toMatchObject({ held: false, code: 1 });
  });

  it("keeps a skip that the export states", () => {
    const report = dry({
      exists: { user: 1, organization: 0 },
      skipped: [{ kind: "user", sourceId: "u2", reason: "deleted" }],
    });
    expect(verifyReport(report)).toEqual({
      held: true,
      wouldWrite: 0,
      partial: 0,
      needPerson: 0,
      code: 0,
    });
  });

  it("prints counts and no source id", () => {
    const held = dry();
    expect(verifyLine(verifyReport(held), held)).toBe(
      "verify: the database holds this export: user 2, organization 0",
    );
    const cases: ImportReport[] = [
      dry({ created: { ...NONE, user: 1 } }),
      dry({ partial: [{ kind: "user", sourceId: "u-partial", missing: ["password"] }] }),
      dry({ skipped: [{ kind: "user", sourceId: "u-taken", reason: "email_taken" }] }),
      dry({ dryRun: false }),
    ];
    const lines = cases.map((r) => verifyLine(verifyReport(r), r));
    expect(lines[0]).toBe(
      "verify: the database does not hold this export: 1 records would be written, 0 partial, 0 need a person",
    );
    expect(lines[1]).toBe(
      "verify: the database does not hold this export: 0 records would be written, 1 partial, 0 need a person",
    );
    expect(lines[2]).toBe(
      "verify: the database does not hold this export: 0 records would be written, 0 partial, 1 need a person",
    );
    for (const line of [...lines, verifyLine(verifyReport(held), held)]) {
      expect(line).toMatch(/^verify: the database (holds|does not hold) this export: [a-z ,0-9]+$/);
      expect(line).not.toContain("u-");
    }
  });
});
