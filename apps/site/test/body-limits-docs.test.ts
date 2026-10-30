import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The request body limits of core (rulings 43, 46, 51, and 56 of the 12j
// lane). The errors page, the limits page, the Express and Fastify pages, the
// core README, and the Express README state the caps and the scan limits by
// hand. This test reads each constant from the source of core and each
// number from the pages, in the form of sso-scim-limits.test.ts. A new
// derivation that changes a constant fails here until each line says the new
// value. A cap number in one of the files that no fact holds fails too, so no
// line drifts unseen.

const BODY_CAP = `${REPO}packages/core/src/http/body-cap.ts`;
const source = readFileSync(BODY_CAP, "utf8");

/** The text of a file with each run of white space as one space: a README line wraps. */
function textOf(file: string): string {
  return readFileSync(file, "utf8").replace(/\s+/g, " ");
}

const FILES = {
  errors: `${DOCS}docs/reference/errors.md`,
  limits: `${DOCS}docs/reference/limits.md`,
  express: `${DOCS}docs/reference/express.md`,
  fastify: `${DOCS}docs/reference/fastify.md`,
  readme: `${REPO}packages/core/README.md`,
  expressReadme: `${REPO}packages/express/README.md`,
} as const;
type FileKey = keyof typeof FILES;

/** The value of a numeric text of the source: digits with `_`, and products such as `2 * 8_388_608`. */
function numberOf(text: string): number {
  return text
    .split("*")
    .map((part) => Number(part.trim().replaceAll("_", "")))
    .reduce((a, b) => a * b, 1);
}

/** The value of `export const NAME = <number>;` in body-cap.ts. */
function constant(name: string): number {
  const m = new RegExp(`export const ${name} = ([0-9_ *]+);`).exec(source);
  if (!m) throw new Error(`no constant ${name} in body-cap.ts`);
  return numberOf(m[1] ?? "");
}

/** The cap of a route of `BODY_CAPS` in body-cap.ts. */
function capOf(route: string): number {
  const m = new RegExp(`"${route}": ([0-9_]+),`).exec(source);
  if (!m) throw new Error(`no cap of ${route} in BODY_CAPS`);
  return numberOf(m[1] ?? "");
}

/** The number that `re` captures in `file`, at each match. A unit of KiB or MiB counts in bytes. */
function stated(file: FileKey, re: RegExp): number[] {
  const found = [...textOf(FILES[file]).matchAll(new RegExp(re, "g"))].map((m) => {
    const n = Number(m[1] ?? "");
    return m[2] === "MiB" ? n * 1_048_576 : m[2] === "KiB" ? n * 1024 : n;
  });
  if (found.length === 0) throw new Error(`no match of ${re} in ${file}`);
  return found;
}

// Each fact: its value in the source, and the lines that state it.
const facts: [string, () => number, [FileKey, RegExp][]][] = [
  [
    "the floor of every route",
    () => constant("BODY_CAP_FLOOR"),
    [
      ["errors", /The cap is (\d+) bytes, \d+ bytes for `POST \/social\/apple\/callback`/],
      ["errors", /The body reads of the routes with a cap above (\d+) bytes hold/],
      ["errors", /A body at the floor of (\d+) bytes never gets it/],
      ["limits", /\| One request body of any other route \| (\d+) bytes, /],
      [
        "limits",
        /\| The bytes that the body reads of the routes with a cap above (\d+) bytes hold/,
      ],
      ["readme", /The cap is (\d+) (KiB), \d+ KiB for the Apple callback/],
      ["readme", /The body reads of the routes with a cap above (\d+) (KiB) hold/],
    ],
  ],
  [
    "the cap of the Apple callback",
    () => capOf("POST /social/apple/callback"),
    [
      ["errors", /(\d+) bytes for `POST \/social\/apple\/callback`/],
      ["limits", /bytes, (\d+) for `POST \/social\/apple\/callback`/],
      ["readme", /(\d+) (KiB) for the Apple callback/],
    ],
  ],
  [
    "the cap of each SSO connection write",
    () => capOf("POST /sso/connections/create"),
    [
      ["errors", /and (\d+) bytes for the two SSO connection writes/],
      ["limits", /and (\d+) for the two SSO connection writes/],
      ["readme", /and (\d+) (MiB) for the two SSO connection writes/],
      // The measure of ruling 56: a parser at this cap on the two SSO paths stopped a process.
      ["express", /with their cap of (\d+) (MiB) as its limit/],
      ["expressReadme", /with their cap of (\d+) (MiB) as its limit/],
    ],
  ],
  [
    "the update cap, as the create cap",
    () => capOf("POST /sso/connections/update"),
    [["readme", /and (\d+) (MiB) for the two SSO connection writes/]],
  ],
  [
    "the largest cap",
    () => constant("REQUEST_BODY_MAX"),
    [["readme", /and (\d+) (MiB) for the two SSO connection writes \(`REQUEST_BODY_MAX`\)/]],
  ],
  [
    "the depth limit",
    () => constant("BODY_DEPTH_MAX"),
    [
      ["limits", /\| Nesting of one JSON request body \| (\d+) levels/],
      ["readme", /A JSON body nested deeper than (\d+) or/],
    ],
  ],
  [
    "the levels left to a metadata record at depth 2",
    () => constant("BODY_DEPTH_MAX") - 2,
    [
      ["limits", /\| The `metadata` of one API token \| \d+ bytes as JSON, and (\d+) levels/],
      ["limits", /\| The `metadata` of one organization \| \d+ bytes as JSON, and (\d+) levels/],
    ],
  ],
  [
    "the item limit",
    () => constant("BODY_ITEMS_MAX"),
    [
      ["limits", /\| Items of one JSON request body \| (\d+) of/],
      ["readme", /or with more than (\d+) items answers `invalid_body`/],
    ],
  ],
  [
    "the pair limit of a form",
    () => constant("FORM_PAIRS_MAX"),
    [
      ["limits", /\| Pairs of one form request body \| (\d+), /],
      ["readme", /A form body of more than (\d+) pairs/],
    ],
  ],
  [
    "the budget of the large reads",
    () => constant("LARGE_READ_BUDGET"),
    [
      ["errors", /bytes hold (\d+) bytes in this isolate now/],
      ["limits", /hold at once in one isolate \| (\d+), /],
      ["readme", /hold at most (\d+) (MiB) at once in one isolate/],
    ],
  ],
  [
    "the budget in reads of the largest cap",
    () => constant("LARGE_READ_BUDGET") / constant("REQUEST_BODY_MAX"),
    [["limits", /hold at once in one isolate \| \d+, (\d+) reads of the largest cap/]],
  ],
  [
    "the seconds of Retry-After",
    () => constant("BODY_BUSY_RETRY_SECONDS"),
    [
      ["errors", /The answer carries `Retry-After: (\d+)`/],
      ["limits", /503 `body_busy` with `Retry-After: (\d+)`/],
      ["readme", /answers 503 `body_busy` with `Retry-After: (\d+)`/],
    ],
  ],
];

/** The cap numbers that a file may state only where a fact holds them. */
const CAP_NUMBERS = /\b(65536|262144|8388608|16777216)\b/g;

describe("the request body limits of core and the docs (rulings 43, 46, 51, and 56 of the 12j lane)", () => {
  for (const [name, value, lines] of facts)
    it(`states ${name} as the source has it`, () => {
      const want = value();
      for (const [file, re] of lines)
        for (const got of stated(file, re))
          expect({ name, file, re: re.source, got }).toEqual({
            name,
            file,
            re: re.source,
            got: want,
          });
    });

  it("states no cap number in bytes that no fact holds", () => {
    for (const file of Object.keys(FILES) as FileKey[]) {
      const text = textOf(FILES[file]);
      const all = [...text.matchAll(CAP_NUMBERS)].length;
      // Each number in bytes that a fact holds in the file, by its place in the text.
      const held = new Set<number>();
      for (const [, , lines] of facts)
        for (const [f, re] of lines)
          if (f === file)
            for (const m of text.matchAll(new RegExp(re, "gd")))
              if (m[2] === undefined && new RegExp(CAP_NUMBERS.source).test(`${m[1]}`))
                held.add(m.indices?.[1]?.[0] ?? -1);
      expect({ file, all }).toEqual({ file, all: held.size });
    }
  });
});
