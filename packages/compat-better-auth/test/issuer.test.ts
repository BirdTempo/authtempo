import { DatabaseSync } from "node:sqlite";
import { PROVIDER_NAME_RE } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import shippedBefore17 from "../migrations/d1-before-1.7/0001_compat_better_auth.sql?raw";
import { issuerFor } from "../src/storage/mapping.js";
import { before17 } from "./d1/sql.js";
import { BETTER_AUTH_SQLITE } from "./fixtures.js";

describe("the issuer of a provider id (plan 9b2)", () => {
  it("leaves every name that core's provider name rule allows unchanged under encodeURIComponent", () => {
    // Every UTF-16 code unit that the rule allows after the first letter. The
    // first letter's class is a subset, so this covers every allowed name.
    const allowed: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if (PROVIDER_NAME_RE.test(`a${ch}`)) allowed.push(ch);
    }
    expect(allowed.join("")).toBe("-0123456789abcdefghijklmnopqrstuvwxyz");
    for (const ch of allowed) expect(encodeURIComponent(ch)).toBe(ch);
    for (const name of ["acme", "acme-2", "x", `a${"b".repeat(31)}`]) {
      expect(PROVIDER_NAME_RE.test(name)).toBe(true);
      expect(issuerFor(name)).toBe(`local:oauth:${name}`);
    }
  });

  it("fills the issuer that issuerFor writes, in migration 0001 on tables from before 1.7", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(before17(BETTER_AUTH_SQLITE));
    db.exec(
      `INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u','U','u@example.com',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');`,
    );
    const providers = ["github", "linkedin", "acme-2", "credential", "email", "google", "apple"];
    for (const [n, p] of providers.entries())
      db.exec(
        `INSERT INTO "account" ("id","accountId","providerId","userId","createdAt","updatedAt") VALUES ('a${n}','s${n}','${p}','u','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');`,
      );
    db.exec(shippedBefore17);
    const rows = db.prepare(`SELECT "providerId", "issuer" FROM "account" ORDER BY "id"`).all() as {
      providerId: string;
      issuer: string;
    }[];
    expect(rows.map((r) => r.providerId)).toEqual(providers);
    for (const r of rows) expect(r.issuer).toBe(issuerFor(r.providerId));
  });
});
