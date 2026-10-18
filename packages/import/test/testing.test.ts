import { createMemoryAdapter } from "@authtempo/core";
import { VECTORS } from "@authtempo/legacy-hashes/testing";
import { describe, expect, it } from "vitest";
import { importUsers } from "../src/import.js";
import { exitCode } from "../src/report.js";
import { PROVIDER_FILES, readSource } from "../src/sources.js";
import { FIXTURE_EXPORTS } from "../src/testing.js";
import type { SourceName } from "../src/types.js";

const now = () => new Date("2026-10-19T00:00:00.000Z");
const providers = Object.keys(FIXTURE_EXPORTS) as SourceName[];
const ADDRESS = /[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Every hash string a fixture can hold: the known-answer vectors are the one source of the hashes. */
const HASHES = Object.values(VECTORS).map((v) => v.stored);

describe("FIXTURE_EXPORTS", () => {
  it("has one fixture export per provider", () => {
    const fixtures = Object.keys(FIXTURE_EXPORTS).sort();
    const known = Object.keys(PROVIDER_FILES).sort();
    expect(fixtures).toEqual(known);
    for (const name of known) expect(FIXTURE_EXPORTS).toHaveProperty(name);
    for (const name of fixtures) expect(PROVIDER_FILES).toHaveProperty(name);
  });

  it("imports each fixture export with no refusal and no conflict", async () => {
    for (const name of providers) {
      const f = FIXTURE_EXPORTS[name];
      expect(f.bundle.provider).toBe(name);
      const report = await importUsers(createMemoryAdapter(), await readSource(f.bundle), {
        formats: f.formats,
        legacyVerify: f.legacyVerify,
        now,
      });
      expect([name, exitCode(report)]).toEqual([name, 0]);
      expect(report.created.user, name).toBeGreaterThanOrEqual(1);
      if (f.signIn !== null) expect(f.signIn.email, name).toMatch(ADDRESS);
    }
  });

  it("names each secret that the fixture holds", () => {
    for (const name of providers) {
      const f = FIXTURE_EXPORTS[name];
      const text = Object.values(f.bundle.files).join("\n");
      expect(f.secrets.length, name).toBeGreaterThan(0);
      for (const secret of f.secrets) expect(text, `${name}: ${secret}`).toContain(secret);
      // Every address of the fixture.
      for (const address of text.match(ADDRESS) ?? [])
        expect(f.secrets, `${name}: ${address}`).toContain(address);
      // Every hash string of the fixture.
      for (const hash of HASHES.filter((h) => text.includes(h)))
        expect(f.secrets, `${name}: ${hash}`).toContain(hash);
      // Every fixture has a name: at least one secret is neither an address nor a tagged hash.
      expect(
        f.secrets.filter((s) => !s.includes("@") && !s.startsWith("$")),
        `${name}: a name`,
      ).not.toHaveLength(0);
    }
    // Firebase writes its hash as plain base64, with no tag: the fixture names it as a secret.
    const firebaseHash = VECTORS.firescrypt.stored.split("$").at(-1) as string;
    expect(FIXTURE_EXPORTS.firebase.secrets).toContain(firebaseHash);
  });
});
