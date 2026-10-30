import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkDeprecationsPage,
  type DeprecationsPageInput,
  type RegisterEntry,
} from "../scripts/check-deprecations-page.ts";
import { DOCS, REPO } from "../scripts/lib/paths.ts";
import { summaryLine } from "../scripts/lib/report.ts";

const register = JSON.parse(
  readFileSync(`${REPO}release/deprecations.json`, "utf8"),
) as RegisterEntry[];
const source = readFileSync(`${DOCS}docs/reference/deprecations.md`, "utf8");
/** The anchors that the build writes for each `### <id>` heading. */
const built = register.map((e) => `<h3 id="${e.id}">${e.id}</h3>`).join("");
const REAL: DeprecationsPageInput = { register, source, built };

const failures = (input: DeprecationsPageInput) => checkDeprecationsPage(input).failures;

describe("check-deprecations-page", () => {
  it("passes the real page against the real register", () => {
    expect(summaryLine(checkDeprecationsPage(REAL))).toBe(
      `check-deprecations-page: PASS entries=${register.length} sections=${register.length} anchors=${register.length} failures=0`,
    );
  });

  it("holds one anchor per register entry, both ways", () => {
    const [first] = register;
    if (first === undefined) throw new Error("the register is empty");
    // A register entry with no section on the page.
    expect(
      failures({ ...REAL, source: source.replace(`### ${first.id}\n`, "### gone\n") }),
    ).toEqual([
      `docs/reference/deprecations.md has no section "### ${first.id}" under "## The entries"`,
      'docs/reference/deprecations.md has the section "### gone", which the register lacks',
    ]);
    // A section with no register entry.
    expect(failures({ ...REAL, register: register.slice(1) })).toEqual([
      `docs/reference/deprecations.md has the section "### ${first.id}", which the register lacks`,
    ]);
    // A built page with no anchor of the entry.
    expect(failures({ ...REAL, built: built.replace(`id="${first.id}"`, 'id="x"') })).toEqual([
      `${first.id}: the built page has no anchor #${first.id}`,
    ]);
  });

  it("holds the what and the removeIn of each entry", () => {
    const [first] = register;
    if (first === undefined) throw new Error("the register is empty");
    const moved = register.map((e) => (e.id === first.id ? { ...e, removeIn: "0.3.0" } : e));
    expect(failures({ ...REAL, register: moved })).toEqual([
      `${first.id}: the page does not state "- Removed in: \`0.3.0\`"`,
    ]);
    const changed = register.map((e) => (e.id === first.id ? { ...e, what: "Other text." } : e));
    expect(failures({ ...REAL, register: changed })).toEqual([
      `${first.id}: the page text is not the what of the register: Other text.`,
    ]);
    const since = register.map((e) => (e.id === first.id ? { ...e, since: "0.2.0" } : e));
    expect(failures({ ...REAL, register: since })).toEqual([
      `${first.id}: the page does not state "- Deprecated since: \`0.2.0\`"`,
    ]);
  });

  it("fails a missing page and an empty register", () => {
    expect(failures({ register: [], source: "", built: "" })).toEqual([
      "docs/reference/deprecations.md does not exist",
      "read 0 entries",
      "read 0 sections",
    ]);
  });
});
