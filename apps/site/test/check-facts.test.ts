import { describe, expect, it } from "vitest";
import { checkFacts } from "../scripts/check-facts.ts";
import { checkSentences } from "../scripts/check-sentences.ts";
import { checkTerms } from "../scripts/check-terms.ts";
import { COMPARE_PROSE_PATH, compareProsePage } from "../scripts/lib/compare-prose.ts";
import { docsPages } from "../scripts/lib/load.ts";
import { prosePages } from "../scripts/lib/prose.ts";
import { COMPARE_ROWS, type CompareRow, type HostedModel } from "../src/data/compare.ts";

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
      source: "https://better-auth.com/docs/plugins/magic-link",
      read,
    },
    {
      id: "a4",
      topic: "PKCE",
      authtempo: "S256 on every code.",
      betterAuth: "S256 only.",
      side: "parity",
      source: "https://better-auth.com/docs/plugins/oauth-provider; docs/superpowers/plans/x.md",
      read: "2026-10-14",
    },
    {
      id: "a13",
      topic: "Device grant",
      authtempo: "No device grant.",
      betterAuth: "Has the device grant.",
      side: "better-auth",
      source: "npm better-auth@1.7.2, dist/plugins/device-authorization/index.mjs",
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
/** The tracked files of the repository that the fixture sources name. */
const TRACKED = new Set([
  "apps/site/src/content/docs/docs/migrate/clerk.mdx",
  "docs/superpowers/plans/x.md",
]);

function run(
  over: Partial<{
    rows: CompareRow[];
    models: HostedModel[];
    providers: string[];
    built: string;
    files: Set<string>;
    tracked: Set<string>;
  }> = {},
) {
  return checkFacts({
    rows: over.rows ?? rows(),
    models: over.models ?? models(),
    providers: over.providers ?? ["clerk"],
    built: over.built ?? page(),
    files: over.files ?? FILES,
    tracked: over.tracked ?? TRACKED,
    today: TODAY,
  });
}

describe("checkFacts (plan 11b Task 6)", () => {
  it("passes rows read today", () => {
    const r = run();
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ rows: 3, models: 1, oldest_days: 0, tracked: 2 });
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

  it("fails a source that is not public and not a tracked file (final review m4)", () => {
    const internal = rows().map((x) =>
      x.id === "b5" ? { ...x, source: "review-vs-better-auth.md, row b5" } : x,
    );
    expect(run({ rows: internal }).failures).toEqual([
      'cmp-b5 names "review-vs-better-auth.md, row b5", which is not public and not a tracked file',
    ]);
    // Each part counts: a public first part does not carry an untracked second part.
    expect(
      run({ tracked: new Set(["apps/site/src/content/docs/docs/migrate/clerk.mdx"]) }).failures,
    ).toEqual([
      'cmp-a4 names "docs/superpowers/plans/x.md", which is not public and not a tracked file',
    ]);
    const other = rows().map((x) =>
      x.id === "b5" ? { ...x, source: "https://better-auth.com.evil.example/docs/x" } : x,
    );
    expect(run({ rows: other }).failures).toHaveLength(1);
    expect(run({ tracked: new Set() }).failures).toContain("read 0 tracked");
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

  it.each([
    ["$25 a month", "$25"],
    ["$<span>25</span> a month", "$ 25"],
    ["&#36;25 a month", "$25"],
    ["€0.02 per user", "€0.02"],
    ["£25 a month", "£25"],
    ["¥300 a month", "¥300"],
    ["25,00 € a month", "25,00 €"],
    ["25 USD a month", "25 USD"],
    ["USD 25 a month", "USD 25"],
    ["25 dollars a month", "25 dollars"],
    ["25 US dollars a month", "25 US dollars"],
    ["9 euros a month", "9 euros"],
  ])("fails the price %s on the page", (cell, found) => {
    const built = page().replace("<td>Cell</td>", `<td>${cell}</td>`);
    expect(run({ built }).failures).toEqual([`the page names a price: "${found}"`]);
  });

  // A price at the end of a cell: the next cell must not join its last word.
  it.each([
    ["25 USD", "25 USD"],
    ["25 US dollars", "25 US dollars"],
    ["25 £", "25 £"],
    ["300 ¥", "300 ¥"],
  ])("fails the price %s as the whole cell", (cell, found) => {
    const built = page().replace("<td>Cell</td>", `<td>${cell}</td>`);
    expect(run({ built }).failures).toEqual([`the page names a price: "${found}"`]);
  });

  // A code needs a word boundary before it (Task 6 review, Info 2 and Low 1).
  it.each(["Pasteur 3", "Mjpy 5", "thusd 7"])(
    "passes %s, where a code ends a longer word",
    (cell) => {
      const built = page().replace("<td>Cell</td>", `<td>${cell}</td>`);
      expect(run({ built }).failures).toEqual([]);
    },
  );

  it("fails a page with no main element, where a price would hide", () => {
    const built = page().replace('<main id="main">', "<div>").replace("</main>", "</div>");
    expect(run({ built: built.replace("<td>Cell</td>", "<td>$25</td>") }).failures).toEqual([
      'the page has no <main id="main"> element',
    ]);
  });

  it("reads the build day as a UTC day, at any hour of that day", () => {
    const late = new Date("2026-10-14T23:59:00Z");
    const r = checkFacts({
      rows: rows("2026-04-17"),
      models: models(),
      providers: ["clerk"],
      built: pageRead("2026-04-17"),
      files: FILES,
      tracked: TRACKED,
      today: late,
    });
    expect(r.failures).toEqual([]);
    expect(r.counts.oldest_days).toBe(180);
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

describe("the sides of /compare/ (rulings 25 and 26 of the plan 11b lane)", () => {
  // The strict rule: parity only when authtempo has each part of the Better Auth cell.
  it("puts each review row on its ruled side", () => {
    const of = (side: string) =>
      COMPARE_ROWS.filter((r) => r.side === side)
        .map((r) => r.id)
        .sort();
    expect(of("authtempo")).toEqual(
      ["a26", "b5", "d11", "e7", "f16", "f18", "f4", "g14", "g3", "g6"].sort(),
    );
    expect(of("parity")).toEqual(
      [
        "a18",
        "a4",
        "a9",
        "b1",
        "b29",
        "b41",
        "b8",
        "d12",
        "e10",
        "f10",
        "f12",
        "f2",
        "f3",
        "f6",
      ].sort(),
    );
    expect(of("better-auth")).toHaveLength(50);
    // Ruling 27: an authtempo row with a lack by design names the lack and its reason.
    for (const id of ["f4", "f16", "g6"])
      expect({
        id,
        named: /, by design: /.test(COMPARE_ROWS.find((r) => r.id === id)?.authtempo ?? ""),
      }).toEqual({
        id,
        named: true,
      });
    for (const id of ["a31", "a32", "b28", "b3", "b31", "b6", "d5", "e1", "f11", "g8"])
      expect({ id, side: COMPARE_ROWS.find((r) => r.id === id)?.side }).toEqual({
        id,
        side: "better-auth",
      });
  });
});
