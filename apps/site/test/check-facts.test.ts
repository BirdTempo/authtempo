import { describe, expect, it } from "vitest";
import { checkFacts } from "../scripts/check-facts.ts";
import { checkSentences } from "../scripts/check-sentences.ts";
import { checkTerms } from "../scripts/check-terms.ts";
import { COMPARE_PROSE_PATH, compareProsePage } from "../scripts/lib/compare-prose.ts";
import { docsPages } from "../scripts/lib/load.ts";
import { prosePages } from "../scripts/lib/prose.ts";
import type { CompareRow, HostedModel } from "../src/data/compare.ts";

/** The build day of every test (plan 11b Task 6). */
const TODAY = new Date("2026-10-14");

/** One row of each side, so the rule "each side has a row" holds. */
function rows(read = "2026-10-14"): CompareRow[] {
  return [
    {
      id: "b5",
      topic: "Magic link",
      authtempo: "The link opens a confirm page.",
      betterAuth: "Has a magic link.",
      side: "authtempo",
      source: "review-vs-better-auth.md, row b5",
      read,
    },
    {
      id: "a4",
      topic: "PKCE",
      authtempo: "S256 on every code.",
      betterAuth: "S256 only.",
      side: "parity",
      source: "review-vs-better-auth.md, row a4",
      read: "2026-10-14",
    },
    {
      id: "a13",
      topic: "Device grant",
      authtempo: "No device grant.",
      betterAuth: "Has the device grant.",
      side: "better-auth",
      source: "review-vs-better-auth.md, row a13",
      read: "2026-10-14",
    },
  ];
}

function models(): HostedModel[] {
  return [
    {
      provider: "clerk",
      name: "Clerk",
      users: "The provider's database",
      signIn: "The provider's servers",
      importer: "authtempo import clerk",
      guide: "/docs/migrate/clerk/",
      source: "apps/site/src/content/docs/docs/migrate/clerk.mdx",
      read: "2026-10-14",
    },
  ];
}

/** One table row as compare.astro writes it: the id, the cells, and the read cell. */
function tr(id: string, read: string): string {
  return `<tr id="${id}" class="astro-x"><td>Topic</td><td>Cell</td><td>Read ${read}<span>src</span></td></tr>`;
}

/** A /compare/ page with one table row per id; each read date comes from the rows of the fixture. */
function page(
  ids: readonly string[] = ["cmp-b5", "cmp-a4", "cmp-a13", "host-clerk"],
  read: string = rows()[0]?.read ?? "",
): string {
  const day = (id: string) => (id === "cmp-b5" ? read : "2026-10-14");
  return `<main id="main"><table>${ids.map((id) => tr(id, day(id))).join("")}</table></main>`;
}

/** The default page with another read date on the row b5. */
const pageRead = (read: string) => page(undefined, read);

const FILES = new Set(["docs/migrate/clerk/index.html"]);

function run(
  over: Partial<{
    rows: CompareRow[];
    models: HostedModel[];
    providers: string[];
    built: string;
    files: Set<string>;
  }> = {},
) {
  return checkFacts({
    rows: over.rows ?? rows(),
    models: over.models ?? models(),
    providers: over.providers ?? ["clerk"],
    built: over.built ?? page(),
    files: over.files ?? FILES,
    today: TODAY,
  });
}

describe("checkFacts (plan 11b Task 6)", () => {
  it("passes rows read today", () => {
    const r = run();
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ rows: 3, models: 1, oldest_days: 0 });
  });

  it("fails a row read 181 days ago", () => {
    const r = run({ rows: rows("2026-04-16"), built: pageRead("2026-04-16") });
    expect(r.failures).toEqual(["cmp-b5 was read 181 days ago; the limit is 180"]);
  });

  it("passes a row read 180 days ago", () => {
    const r = run({ rows: rows("2026-04-17"), built: pageRead("2026-04-17") });
    expect(r.failures).toEqual([]);
    expect(r.counts.oldest_days).toBe(180);
  });

  it("fails a row read tomorrow", () => {
    const r = run({ rows: rows("2026-10-15"), built: pageRead("2026-10-15") });
    expect(r.failures).toEqual(["cmp-b5 was read on 2026-10-15, after the build day 2026-10-14"]);
  });

  it("fails a read that is not a calendar date", () => {
    for (const read of ["2026-02-30", "2026-10-1", "14 October 2026"]) {
      const r = run({ rows: rows(read), built: pageRead(read) });
      expect(r.failures).toEqual([`cmp-b5 has the read date "${read}", not a YYYY-MM-DD day`]);
    }
  });

  it("fails a row whose read cell on the page is not its read date", () => {
    expect(run({ built: pageRead("2026-10-13") }).failures).toEqual([
      "cmp-b5: the page does not say Read 2026-10-14",
    ]);
  });

  it("fails a row with no source", () => {
    const blank = rows().map((x) => (x.id === "a4" ? { ...x, source: " " } : x));
    expect(run({ rows: blank }).failures).toEqual(["cmp-a4 names no source"]);
    const model = models().map((m) => ({ ...m, source: "" }));
    expect(run({ models: model }).failures).toEqual(["host-clerk names no source"]);
  });

  it("fails a duplicate id", () => {
    const twice = [...rows(), { ...rows()[0], topic: "Again" } as CompareRow];
    expect(run({ rows: twice }).failures).toEqual(["cmp-b5 is the id of 2 rows"]);
  });

  it("fails an importer that PROVIDERS lacks", () => {
    const other = models().map((m) => ({ ...m, importer: "authtempo import okta" }));
    expect(run({ models: other }).failures).toEqual([
      'host-clerk names "authtempo import okta", and okta is not a member of PROVIDERS',
      "clerk is a member of PROVIDERS, and no hosted row names its importer",
    ]);
  });

  it("fails a member of PROVIDERS with no row", () => {
    expect(run({ providers: ["clerk", "workos"] }).failures).toEqual([
      "workos is a member of PROVIDERS, and no hosted row names its importer",
    ]);
  });

  it("fails a guide that the build lacks", () => {
    expect(run({ files: new Set() }).failures).toEqual([
      "host-clerk links /docs/migrate/clerk/, which is not a page of the build",
    ]);
  });

  it("fails a row that the page lacks", () => {
    const r = run({ built: page(["cmp-a4", "cmp-a13", "host-clerk"]) });
    expect(r.failures).toEqual(["the page has no cmp-b5"]);
  });

  it("fails a row id twice on the page, and an id that no row names", () => {
    const r = run({
      built: page(["cmp-b5", "cmp-b5", "cmp-a4", "cmp-a13", "host-clerk", "cmp-z9"]),
    });
    expect(r.failures).toEqual([
      "the page has cmp-b5 2 times",
      "the page has cmp-z9, and no row names it",
    ]);
  });

  it("fails a side with no row", () => {
    const two = rows().filter((x) => x.side !== "better-auth");
    const r = run({ rows: two, built: page(["cmp-b5", "cmp-a4", "host-clerk"]) });
    expect(r.failures).toEqual(['no row has the side "better-auth"']);
  });

  it("fails a price on the page", () => {
    for (const price of ["$25 a month", "€0.02 per user", "25 USD"]) {
      const built = page().replace("<td>Cell</td>", `<td>${price}</td>`);
      expect(run({ built }).failures).toEqual([`the page names a price: "${price}"`]);
    }
  });

  it("fails on zero rows", () => {
    const r = run({ rows: [], models: [], providers: [], built: '<main id="main"></main>' });
    expect(r.failures).toEqual([
      'no row has the side "authtempo"',
      'no row has the side "parity"',
      'no row has the side "better-auth"',
      "read 0 rows",
      "read 0 models",
    ]);
  });
});

describe("the prose of /compare/ (plan 11b Task 6)", () => {
  it("joins prosePages(), so check-terms and check-sentences read each cell", () => {
    expect(prosePages().map((p) => p.path)).toContain(COMPARE_PROSE_PATH);
  });

  it("fails a forbidden term and a long sentence in a cell", () => {
    const long = Array.from({ length: 26 }, () => "word").join(" ");
    const bad = rows().map((x) =>
      x.id === "b5" ? { ...x, authtempo: "A login link.", betterAuth: `${long}.` } : x,
    );
    // check-terms also reads the glossary, so each run holds the docs pages too.
    const ofCompare = (failures: string[]) =>
      failures.filter((f) => f.startsWith(COMPARE_PROSE_PATH));
    const p = compareProsePage(bad, models());
    expect(ofCompare(checkTerms([...docsPages(), p]).failures)).toEqual([
      `${COMPARE_PROSE_PATH}:28: "login" is forbidden; write "sign in"`,
    ]);
    expect(ofCompare(checkSentences([p]).failures)).toHaveLength(1);
    const good = compareProsePage(rows(), models());
    expect(checkTerms([...docsPages(), good]).failures).toEqual([]);
    expect(checkSentences([good]).failures).toEqual([]);
  });
});
