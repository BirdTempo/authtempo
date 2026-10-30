import { readFileSync } from "node:fs";
import { ipKey } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The request body limits of core (rulings 43, 46, 51, 56, 59, 66, and 69 of
// the 12j lane). The errors page, the limits page, the Express and Fastify
// pages, the SCIM guide, the core README, the Express README, and the deploy
// page state the caps and the scan limits by hand. This test reads each constant from the source of core
// and each number from the pages, in the form of sso-scim-limits.test.ts. A
// new derivation that changes a constant fails here until each line says the
// new value. A cap number in one of the files that no fact holds fails too,
// so no line drifts unseen.

const BODY_CAP = `${REPO}packages/core/src/http/body-cap.ts`;
const source = readFileSync(BODY_CAP, "utf8");
/** The SCIM routes of core: the SCIM item limit of the shape scan (ruling 56). */
const scimSource = readFileSync(`${REPO}packages/core/src/http/routes/scim.ts`, "utf8");
/** The SSO routes of core: the limit of the large reads of one user (ruling 69). */
const ssoSource = readFileSync(`${REPO}packages/core/src/http/routes/sso.ts`, "utf8");

/** The text of a file with each run of white space as one space: a README line wraps. */
function textOf(file: string): string {
  return readFileSync(file, "utf8").replace(/\s+/g, " ");
}

const FILES = {
  errors: `${DOCS}docs/reference/errors.md`,
  limits: `${DOCS}docs/reference/limits.md`,
  express: `${DOCS}docs/reference/express.md`,
  fastify: `${DOCS}docs/reference/fastify.md`,
  scim: `${DOCS}docs/guides/scim.mdx`,
  readme: `${REPO}packages/core/README.md`,
  deploy: `${DOCS}docs/operations/deploy.md`,
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

/** The value of `export const NAME = <number>;` in body-cap.ts, or in `text`. */
function constant(name: string, text: string = source): number {
  const m = new RegExp(`export const ${name} = ([0-9_ *]+);`).exec(text);
  if (!m) throw new Error(`no constant ${name} in the source`);
  return numberOf(m[1] ?? "");
}

/** The `max` of `export const NAME = { seconds: <n>, max: <n> };` in routes/sso.ts. */
function limitMax(name: string): number {
  const m = new RegExp(`export const ${name} = \\{ seconds: [0-9_ *]+, max: ([0-9_]+) \\};`).exec(
    ssoSource,
  );
  if (!m) throw new Error(`no limit ${name} in routes/sso.ts`);
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
      // The SCIM body takes the same depth limit (ruling 56).
      ["limits", /\| Nesting and items of one SCIM request body \| (\d+) levels/],
      ["scim", /A body nested deeper than (\d+) levels/],
      ["readme", /A SCIM body nested deeper than (\d+) or/],
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
    "the item limit of a SCIM body",
    () => constant("SCIM_ITEMS_MAX", scimSource),
    [
      [
        "limits",
        /\| Nesting and items of one SCIM request body \| \d+ levels of `\[` and `\{`, and (\d+) items/,
      ],
      ["scim", /or with more than (\d+) items of/],
      ["readme", /or with more than (\d+) items answers 400 `invalidSyntax`/],
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
      ["errors", /bytes hold at most (\d+) bytes in this isolate, in two halves/],
      ["limits", /hold at once in one isolate \| (\d+), /],
      ["readme", /hold at most (\d+) (MiB) at once in one isolate/],
    ],
  ],
  [
    "the user half of the budget",
    () => constant("LARGE_READ_USER_BUDGET"),
    [
      ["errors", /Now the reads of signed-in users hold their half, (\d+) bytes/],
      ["limits", /of signed-in users hold at once, in each isolate \| (\d+), the user half/],
      ["limits", /stalls an SSO connection write of (\d+) (MiB) fills the user half/],
    ],
  ],
  [
    "the anonymous half of the budget",
    () => constant("LARGE_READ_ANON_BUDGET"),
    [
      ["errors", /or the other reads hold theirs, (\d+) bytes/],
      ["limits", /every other body read above the floor holds at once, in each isolate \| (\d+), /],
      ["limits", /so \d+ IPs must send (\d+) (MiB) each/],
    ],
  ],
  [
    "the IPs whose shares fill the anonymous half",
    () => constant("LARGE_READ_ANON_BUDGET") / constant("LARGE_READ_SHARE"),
    [
      ["limits", /The anonymous half holds the shares of (\d+) IPs of/],
      ["limits", /within \d+ s, so (\d+) IPs must send/],
      ["limits", /so a `\/\d+` prefix gives (\d+) keys/],
    ],
  ],
  [
    "the IPv6 prefix whose /64 keys fill the anonymous half",
    () => 64 - Math.log2(constant("LARGE_READ_ANON_BUDGET") / constant("LARGE_READ_SHARE")),
    [["limits", /so a `\/(\d+)` prefix gives \d+ keys/]],
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
  [
    "the idle limit of a large read, in seconds",
    () => constant("LARGE_READ_IDLE_MS") / 1000,
    [
      ["errors", /It got no bytes for (\d+) s, or it ran past/],
      ["limits", /\| The wait of a body read above the floor for its next bytes \| (\d+) s \|/],
      ["readme", /Such a read that gets no bytes for (\d+) s stops and frees its bytes/],
    ],
  ],
  [
    "the least rate of a large read",
    () => constant("LARGE_READ_MIN_RATE"),
    [
      ["errors", /the time of its cap at (\d+) bytes per second/],
      ["limits", /\| The time of its cap at (\d+) bytes per second/],
      ["readme", /cap at (\d+) (KiB) per second/],
    ],
  ],
  [
    "the least time of a large read, in seconds",
    () => constant("LARGE_READ_DEADLINE_FLOOR_MS") / 1000,
    [
      ["errors", /That time is at least (\d+) s\./],
      ["limits", /for a signed-in user, and at least (\d+) s:/],
      // The anonymous reads (ACS, Apple, SCIM) each take the least time (ruling 66).
      ["limits", /Such a read ends within (\d+) s, so/],
      ["limits", /must send \d+ MiB each (\d+) s to keep the half full/],
      // A SCIM body takes the least time, and a stalled one gets a SCIM 408 (ruling 63 b).
      ["scim", /A body that does not arrive within (\d+) s/],
      ["readme", /per second, at least (\d+) s \(`LARGE_READ_MIN_RATE`\)/],
    ],
  ],
  [
    "the least rate of a large read of a signed-in user",
    () => constant("LARGE_READ_USER_MIN_RATE"),
    [
      ["errors", /For a signed-in user, the rate is (\d+) bytes per second/],
      ["errors", /or (\d+) (KiB) per second for a signed-in user/],
      ["limits", /or at (\d+) for a signed-in user/],
      ["limits", /an admin must send it at (\d+) (KiB) per second or more/],
      ["readme", /read of a signed-in user takes (\d+) (KiB) per second/],
    ],
  ],
  [
    "the time of an SSO connection write, in seconds",
    () =>
      Math.max(
        constant("LARGE_READ_DEADLINE_FLOOR_MS"),
        Math.ceil(
          (capOf("POST /sso/connections/create") * 1000) / constant("LARGE_READ_USER_MIN_RATE"),
        ),
      ) / 1000,
    [
      ["limits", /at least \d+ s: (\d+) s for an SSO connection write/],
      ["limits", /fills the user half for at most (\d+) s/],
      ["limits", /delay the SSO connection writes of others by up to (\d+) s/],
      ["limits", /A write that takes more than (\d+) s gets 408/],
      ["limits", /the user half of the body budget at most \d+ times (\d+) s in an hour/],
      ["readme", /so an SSO connection write gets (\d+) s\./],
    ],
  ],
  [
    "the large reads of one user in an hour",
    () => limitMax("SSO_LARGE_READ_PER_USER"),
    [
      ["limits", /and starts at most (\d+) in an hour/],
      ["limits", /by up to \d+ s, (\d+) times per hour/],
      ["limits", /the user half of the body budget at most (\d+) times/],
    ],
  ],
  [
    "the share of one client",
    () => constant("LARGE_READ_SHARE"),
    [
      ["errors", /Or the reads of one client hold its share: (\d+) bytes for an IP/],
      ["limits", /hold at once \| (\d+), a quarter of the budget/],
      ["limits", /the shares of \d+ IPs of (\d+) (MiB) each/],
      // The one client with no IP takes the share of one IP (ruling 69).
      ["limits", /one client, `unknown`, with the share of one IP, (\d+) (MiB)/],
      ["deploy", /In the body budget, it is one client of (\d+) (MiB)/],
      ["deploy", /one client of (\d+) (MiB) in the budget of the large body reads/],
      ["readme", /One client holds at most (\d+) (MiB) of it/],
    ],
  ],
];

/** The cap numbers that a file may state only where a fact holds them. */
const CAP_NUMBERS = /\b(65536|262144|8388608|16777216)\b/g;

describe("the request body limits of core and the docs (rulings 43, 46, 51, 56, 59, 66, and 69 of the 12j lane)", () => {
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

  it("states the key of no IP and of a text that is not an IP as ipKey gives them (ruling 69)", () => {
    const limits = textOf(FILES.limits);
    const noIp = /A request with no client IP keys `([^`]+)`\./.exec(limits)?.[1];
    const text = /A value that is not an IP keys `([^`]+)` and the value/.exec(limits)?.[1];
    expect({ noIp, text: `${text}x` }).toEqual({ noIp: ipKey(null), text: ipKey("x") });
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
