import { describe, expect, it } from "vitest";
import { checkSchema } from "../scripts/check-schema.ts";

const versionRow = (v: number) =>
  `<tr><td>${v}</td><td><code>000${v}_schema_v${v}</code></td><td>tables</td></tr>`;
const compatRow = (name: string) => `<tr><td><code>${name}</code></td><td>what</td></tr>`;
const COMPAT = ["0001_compat_better_auth", "0002_compat_schema_v5"];
const page = (
  versions: number[],
  said: number,
  compat: string[] = COMPAT,
) => `<p>Core at version ${said} needs the migrations up to <code>000${said}_schema_v${said}</code>.</p>
<table><tbody>${versions.map(versionRow).join("")}</tbody></table>
<p><code>SCHEMA_VERSION</code> of <code>@authtempo/core</code> is ${said}.</p>
<table><tbody>${compat.map(compatRow).join("")}</tbody></table>`;

describe("checkSchema", () => {
  it("passes a page that lists each version up to SCHEMA_VERSION and each compat migration", () => {
    const r = checkSchema(page([1, 2, 3], 3), 3, COMPAT);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ version: 3, rows: 3, statements: 2, compat: 2, compatRows: 2 });
  });

  it("refuses a page that lags SCHEMA_VERSION by one version (plan 12c)", () => {
    const r = checkSchema(page([1, 2], 2), 3, COMPAT);
    expect(r.failures).toEqual([
      "version 3 has no row",
      "no sentence says SCHEMA_VERSION of @authtempo/core is 3",
      "a sentence says version 2; SCHEMA_VERSION is 3",
      "a sentence says version 2; SCHEMA_VERSION is 3",
    ]);
  });

  it("refuses a row above the version and a row with the wrong migration", () => {
    const html =
      page([1, 2], 2).replace("<td><code>0002_schema_v2", "<td><code>0002_schema_v9") +
      versionRow(3);
    expect(checkSchema(html, 2, COMPAT).failures).toEqual([
      "version 2 names 0002_schema_v9, not 0002_schema_v2",
      "version 3 is above SCHEMA_VERSION 2",
    ]);
  });

  it("refuses a compat list that lacks a migration of COMPAT_MIGRATION_NAMES", () => {
    const r = checkSchema(page([1], 1, COMPAT.slice(0, 1)), 1, COMPAT);
    expect(r.failures).toEqual([
      "the compat rows are 0001_compat_better_auth; COMPAT_MIGRATION_NAMES is 0001_compat_better_auth, 0002_compat_schema_v5",
    ]);
  });

  it("fails on an empty page", () => {
    expect(checkSchema("", 8, COMPAT).failures).toEqual([
      "version 1 has no row",
      "version 2 has no row",
      "version 3 has no row",
      "version 4 has no row",
      "version 5 has no row",
      "version 6 has no row",
      "version 7 has no row",
      "version 8 has no row",
      "no sentence says SCHEMA_VERSION of @authtempo/core is 8",
      "the compat rows are none; COMPAT_MIGRATION_NAMES is 0001_compat_better_auth, 0002_compat_schema_v5",
      "read 0 rows",
      "read 0 statements",
      "read 0 compatRows",
    ]);
  });
});
