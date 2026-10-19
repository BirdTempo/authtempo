import { createMemoryAdapter, LEGACY_VERIFY_HASH } from "@authtempo/core";
import { VECTORS } from "@authtempo/legacy-hashes/testing";
import { describe, expect, it } from "vitest";
import { importUsers } from "../src/import.js";
import { summary } from "../src/report.js";
import type { ImportRecord } from "../src/types.js";
import { BCRYPT, listSource, user } from "./source.js";

// The hash format counts of the report (plan 11f Task 3; spec 23 items 5 and
// 14): one count per user record of the export, by the format of its hash,
// the reader's refused tag, or `none`. The operator checks the line against
// `--formats` before the real run. The summary prints tags and counts only.

/** Four users: a bcrypt hash, an argon2id hash, a reader refusal, and no password. */
const four = (): ImportRecord[] => [
  user("u1", { password: { hash: BCRYPT } }),
  user("u2", { password: { hash: VECTORS.argon2id.stored } }),
  user("u3", { password: { refused: "md5" } }),
  user("u4"),
];

const run = (records: ImportRecord[], legacyVerify = false) =>
  importUsers(createMemoryAdapter(), listSource(records), {
    formats: ["bcrypt", "argon2id"],
    legacyVerify,
  });

describe("ImportReport.hashFormats", () => {
  it("counts the hash format of each user", async () => {
    const report = await run(four());
    expect(Object.entries(report.hashFormats)).toEqual([
      ["bcrypt", 1],
      ["argon2id", 1],
      ["md5", 1],
      ["none", 1],
    ]);
  });

  it("prints the hash line after the refusals line", async () => {
    const lines = summary(await run(four()));
    expect(lines[3]).toBe("refusals: 0");
    expect(lines[4]).toBe("hashes: bcrypt 1, argon2id 1, md5 1, none 1");
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
