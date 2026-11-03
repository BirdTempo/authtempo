import { existsSync, readFileSync } from "node:fs";
import { ipKey } from "@authtempo/core";
import { describe, expect, it } from "vitest";
// The derivation of core's body limits: the largest valid body of each route (ruling 84 Low 2).
import { largestBodies } from "../../../packages/core/test/body-limits.ts";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The request body limits of core (rulings 43, 46, 51, 56, 59, 63, 64, 66,
// 68, 69, 72, 75, 79, and 84 of the 12j lane). The errors page, the limits page, the Express,
// Fastify, and SvelteKit pages, the SCIM guide, the core README, the Express
// README, and the deploy page state the caps and the scan limits by hand.
// This test reads each constant from the source of core
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
  sveltekit: `${DOCS}docs/reference/sveltekit.md`,
  // Plan 12l adds the routes page for its order sentence. So each cap that
  // the page states in bytes needs a fact below, as on the other pages.
  routes: `${DOCS}docs/reference/routes.md`,
  // Plan 12l adds the client page for its paragraph on the two SSO writes (ruling 25).
  client: `${DOCS}docs/reference/client.md`,
} as const;
type FileKey = keyof typeof FILES;

// The README of the compat package, for its SSO order sentences (rr-final M1
// and L1 of plan 12l). It is not in FILES: FILES holds each cap number of a
// file, and this README states a SAML size, 262144, that is no body cap.
const COMPAT_README = `${REPO}packages/compat-better-auth/README.md`;
// The changeset of plan 12l. The version branch deletes it, so its fact skips there.
const WRITE_ORDER_CHANGESET = `${REPO}.changeset/sso-write-order.md`;
// The SSO guard of core: the bound of the member rows of its pre-check (rr-final L2).
const GUARD = `${REPO}packages/core/src/engine/sso/guard.ts`;

/** The text of the errors page from the heading of `code` to the next heading. */
function errorSection(code: string): string {
  const text = textOf(FILES.errors);
  const start = text.indexOf(`<h3 id="${code}">`);
  if (start < 0) throw new Error(`no heading of ${code} on the errors page`);
  const end = text.indexOf("<h3 ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The ids of the SSO routes of the routes page whose Errors cell names `code`. */
function ssoRoutesAnswering(code: string): string[] {
  return readFileSync(FILES.routes, "utf8")
    .split('<h3 id="')
    .slice(1)
    .flatMap((section) => {
      const id = section.slice(0, section.indexOf('"'));
      const errors = /^\| Errors \|(.*)$/m.exec(section)?.[1] ?? "";
      return /^(get|post)-sso-/.test(id) && errors.includes(`(/docs/reference/errors/#${code})`)
        ? [id]
        : [];
    });
}

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

/** The `seconds` of `export const NAME = { seconds: <n>, max: <n> };` in routes/sso.ts. */
function limitSeconds(name: string): number {
  const m = new RegExp(`export const ${name} = \\{ seconds: ([0-9_]+), max: [0-9_ *]+ \\};`).exec(
    ssoSource,
  );
  if (!m) throw new Error(`no limit ${name} in routes/sso.ts`);
  return numberOf(m[1] ?? "");
}

/** The seconds of each unit in which the routes page states the window of a limit. */
const UNIT_SECONDS: Readonly<Record<string, number>> = { minute: 60, hour: 3600 };

/** The password sign-ups of one IP in an hour: `SIGN_UP_PER_IP` of engine/password.ts. */
function signUpsPerIpHour(): number {
  const text = readFileSync(`${REPO}packages/core/src/engine/password.ts`, "utf8");
  const m = /const SIGN_UP_PER_IP = \{ seconds: ([0-9_]+), max: ([0-9_]+) \};/.exec(text);
  if (!m) throw new Error("no SIGN_UP_PER_IP in engine/password.ts");
  // The page says "per hour".
  if (numberOf(m[1] ?? "") !== 3600) throw new Error("SIGN_UP_PER_IP is not per hour");
  return numberOf(m[2] ?? "");
}

/** The time of an SSO connection write in seconds: the cap at the rate of a user, at least the floor. */
const ssoWriteSeconds = () =>
  Math.max(
    constant("LARGE_READ_DEADLINE_FLOOR_MS"),
    Math.ceil(
      (capOf("POST /sso/connections/create") * 1000) / constant("LARGE_READ_USER_MIN_RATE"),
    ),
  ) / 1000;

/** The time in seconds that a large read of a user may take with no spend (ruling 79). */
const slowSeconds = () => constant("LARGE_READ_SLOW_MS") / 1000;

/** The SSO connection writes: the routes of the largest valid write of the limits page. */
const SSO_WRITES = ["POST /sso/connections/create", "POST /sso/connections/update"];

/**
 * The bytes of the largest valid SSO connection write, as core derives them
 * from the route contract (ruling 84 Low 2). Today it is largestBodies()[0],
 * which core's derivation test of LARGE_READ_SLOW_MS reads. When no route
 * of the list is in the contract, the value is -Infinity, and each fact of
 * it fails.
 */
const largestWrite = () =>
  Math.max(...largestBodies().flatMap((r) => (SSO_WRITES.includes(r.key) ? [r.bytes] : [])));

/** The reads within that time, each with no spend, that fill the window (ruling 79). */
const slowReads = () => Math.ceil(limitSeconds("SSO_LARGE_READ_PER_USER") / slowSeconds());

/**
 * The seconds that one account holds the user half in a window (ruling 79):
 * each read but the last within the time of no spend, and the last read,
 * with no start left to spend, to the time of an SSO connection write.
 */
const holdOfAccount = () =>
  (limitMax("SSO_LARGE_READ_PER_USER") - 1) * slowSeconds() + ssoWriteSeconds();

/** The least accounts that hold the user half for the window (ruling 79). */
const leastAccounts = () => Math.ceil(limitSeconds("SSO_LARGE_READ_PER_USER") / holdOfAccount());

/** The MiB of the cap of an SSO connection write: what one read sends to hold the user half. */
const capMiB = () => capOf("POST /sso/connections/create") / 1_048_576;

/** The accounts whose 6 holds each fill the window, before the spend of slow reads. */
const accountsOfHolds = () =>
  Math.ceil(
    limitSeconds("SSO_LARGE_READ_PER_USER") /
      (limitMax("SSO_LARGE_READ_PER_USER") * ssoWriteSeconds()),
  );

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
      ["routes", /The cap is (\d+) bytes, except \d+ bytes for `POST \/social\/apple\/callback`/],
      ["routes", /The body reads of the routes with a cap above (\d+) bytes hold at most/],
    ],
  ],
  [
    "the cap of the Apple callback",
    () => capOf("POST /social/apple/callback"),
    [
      ["errors", /(\d+) bytes for `POST \/social\/apple\/callback`/],
      ["limits", /bytes, (\d+) for `POST \/social\/apple\/callback`/],
      ["readme", /(\d+) (KiB) for the Apple callback/],
      ["routes", /except (\d+) bytes for `POST \/social\/apple\/callback`/],
    ],
  ],
  [
    "the cap of each SSO connection write",
    () => capOf("POST /sso/connections/create"),
    [
      ["errors", /and (\d+) bytes for the two SSO connection writes/],
      ["limits", /and (\d+) for the two SSO connection writes/],
      // What each read of the residual sends (ruling 79).
      ["limits", /Each read sends about (\d+) (MiB), so the hour/],
      ["readme", /and (\d+) (MiB) for the two SSO connection writes/],
      // The measure of ruling 56: a parser at this cap on the two SSO paths stopped a process.
      ["express", /with their cap of (\d+) (MiB) as its limit/],
      ["expressReadme", /with their cap of (\d+) (MiB) as its limit/],
      [
        "routes",
        /and (\d+) bytes for `POST \/sso\/connections\/create` and `POST \/sso\/connections\/update`/,
      ],
    ],
  ],
  [
    "the update cap, as the create cap",
    () => capOf("POST /sso/connections/update"),
    [
      ["readme", /and (\d+) (MiB) for the two SSO connection writes/],
      [
        "routes",
        /and (\d+) bytes for `POST \/sso\/connections\/create` and `POST \/sso\/connections\/update`/,
      ],
    ],
  ],
  [
    "the largest cap",
    () => constant("REQUEST_BODY_MAX"),
    [
      ["readme", /and (\d+) (MiB) for the two SSO connection writes \(`REQUEST_BODY_MAX`\)/],
      // The BODY_SIZE_LIMIT of SvelteKit's Node adapter must pass it (ruling 68 Low 3).
      ["sveltekit", /That is (\d+) (MiB), the largest cap of core/],
    ],
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
      // The routes page states both, in its rules of every route (ruling 25 of plan 12l).
      ["routes", /A JSON body nested deeper than (\d+) or with more than \d+ items outside/],
      ["routes", /A SCIM body nested deeper than (\d+) or with more than \d+ items answers/],
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
      ["routes", /or with more than (\d+) items outside its strings answers 400/],
    ],
  ],
  [
    "the cap of a SCIM body",
    () => constant("SCIM_BODY_MAX", scimSource),
    [
      ["errors", /which answer their own SCIM 413 past (\d+) (MiB)/],
      ["limits", /\| One SCIM request body \| (\d+) (MiB) \| SCIM 413 \|/],
      ["scim", /\| A body over (\d+) (MiB) \| 413 \|/],
      ["readme", /SCIM keeps its own (\d+) (MiB) cap/],
      ["sveltekit", /a SCIM body of up to (\d+) (MiB)/],
      ["routes", /The SCIM routes answer their own SCIM 413 past (\d+) bytes/],
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
      ["routes", /or with more than (\d+) items answers SCIM 400 `invalidSyntax`/],
    ],
  ],
  [
    "the pair limit of a form",
    () => constant("FORM_PAIRS_MAX"),
    [
      ["limits", /\| Pairs of one form request body \| (\d+), /],
      ["readme", /A form body of more than (\d+) pairs/],
      ["routes", /A form body of more than (\d+) pairs gets the refusal of a bad form/],
    ],
  ],
  [
    "the budget of the large reads",
    () => constant("LARGE_READ_BUDGET"),
    [
      ["errors", /bytes hold at most (\d+) bytes in this isolate, in two halves/],
      ["limits", /hold at once in one isolate \| (\d+), /],
      ["readme", /hold at most (\d+) (MiB) at once in one isolate/],
      ["routes", /with a cap above \d+ bytes hold at most (\d+) bytes at once in one isolate/],
    ],
  ],
  [
    "the user half of the budget",
    () => constant("LARGE_READ_USER_BUDGET"),
    [
      ["errors", /Now the reads of signed-in users hold their half, (\d+) bytes/],
      ["limits", /of signed-in users hold at once, in each isolate \| (\d+), the user half/],
      ["limits", /stalls an SSO connection write of (\d+) (MiB) fills the user half/],
      ["readme", /The budget has two halves of (\d+) (MiB) that do not lend/],
      ["routes", /The reads of signed-in users hold at most (\d+) bytes of it/],
    ],
  ],
  [
    "the anonymous half of the budget",
    () => constant("LARGE_READ_ANON_BUDGET"),
    [
      ["errors", /or the other reads hold theirs, (\d+) bytes/],
      ["limits", /every other body read above the floor holds at once, in each isolate \| (\d+), /],
      ["limits", /so \d+ IPs must send (\d+) (MiB) each/],
      ["readme", /The budget has two halves of (\d+) (MiB) that do not lend/],
      ["routes", /and every other read at most (\d+) bytes\./],
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
      ["routes", /with `Retry-After: (\d+)`, and no parse runs\. The SCIM routes answer/],
    ],
  ],
  [
    "the idle limit of a large read, in seconds",
    () => constant("LARGE_READ_IDLE_MS") / 1000,
    [
      ["errors", /It got no bytes for (\d+) s, or it ran past/],
      ["limits", /\| The wait of a body read above the floor for its next bytes \| (\d+) s \|/],
      ["readme", /Such a read that gets no bytes for (\d+) s stops and frees its bytes/],
      ["routes", /Such a read that gets no bytes for (\d+) s answers 408/],
    ],
  ],
  [
    "the least rate of a large read",
    () => constant("LARGE_READ_MIN_RATE"),
    [
      ["errors", /the time of its cap at (\d+) bytes per second/],
      ["limits", /\| The time of its cap at (\d+) bytes per second/],
      ["readme", /cap at (\d+) (KiB) per second/],
      // The link that gets 408 for a large body (ruling 72 Low 1).
      ["errors", /A link slower than (\d+) (KiB) per second/],
      ["routes", /a read that runs past the time of its cap at (\d+) bytes per second/],
    ],
  ],
  [
    "the least time of a large read, in seconds",
    () => constant("LARGE_READ_DEADLINE_FLOOR_MS") / 1000,
    [
      ["errors", /That time is at least (\d+) s\./],
      ["limits", /for a signed-in user, and at least (\d+) s\. That is/],
      // The anonymous reads (ACS, Apple, SCIM) each take the least time (ruling 66).
      ["limits", /Such a read ends within (\d+) s, so/],
      ["limits", /must send \d+ MiB each (\d+) s to keep the half full/],
      // A SCIM body takes the least time, and a stalled one gets a SCIM 408 (ruling 63 b).
      ["scim", /A body that does not arrive within (\d+) s/],
      ["readme", /per second, at least (\d+) s \(`LARGE_READ_MIN_RATE`\)/],
      // The other large reads each take the least time (ruling 72 Low 1).
      ["limits", /for an SSO connection write, (\d+) s for the others/],
      ["deploy", /while that caller sends \d+ MiB each (\d+) s\. The callers with an IP key/],
      ["routes", /its cap at \d+ bytes per second, at least (\d+) s\. For a signed-in user/],
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
      ["routes", /For a signed-in user the rate is (\d+) bytes per second/],
    ],
  ],
  [
    "the time of an SSO connection write, in seconds",
    ssoWriteSeconds,
    [
      // The residual of the spend of slow reads (ruling 79).
      ["limits", /\d+ accounts at \d+ times (\d+) s, \d+ s, held the user half/],
      ["limits", /has no start left to spend, so it can run to (\d+) s\./],
      ["limits", /for \d+ times \d+ s and (\d+) s, \d+ s, in a window/],
      ["limits", /at least \d+ s\. That is (\d+) s for an SSO connection write/],
      ["limits", /fills the user half for at most (\d+) s/],
      ["limits", /delay the SSO connection writes of others by up to (\d+) s/],
      ["limits", /A write that takes more than (\d+) s gets 408/],
      ["limits", /the user half of the body budget at most \d+ times (\d+) s in an hour/],
      ["readme", /so an SSO connection write gets (\d+) s\./],
    ],
  ],
  [
    "the time of a large read of a user with no spend, in seconds",
    slowSeconds,
    [
      ["limits", /A read that takes more than (\d+) s spends the rest of the window/],
      // Each end of a slow read spends: a 413 past its cap and a 503 too (ruling 84 Low 1).
      ["errors", /So does such a write whose read ran more than (\d+) s and then ended/],
      ["errors", /whose read ran more than (\d+) s before this code spends/],
      // The residual of the spend of slow reads (ruling 79).
      ["limits", /A large read of a user that takes more than (\d+) s spends the rest/],
      ["limits", /A careful account ends each read within (\d+) s and spends nothing/],
      ["limits", /takes \d+ reads, \d+ s \/ (\d+) s, from/],
      ["limits", /holds the half for \d+ times (\d+) s and \d+ s/],
    ],
  ],
  [
    // The link rate of the derivation of LARGE_READ_SLOW_MS (ruling 84 Low 2).
    "the link rate of the time of a slow read",
    () => constant("LARGE_READ_SLOW_LINK_RATE"),
    [["limits", /At (\d+) (MiB) per second, the largest valid write takes/]],
  ],
  [
    "the time of the largest valid SSO connection write at that rate, in seconds",
    () => Math.round((largestWrite() * 10) / constant("LARGE_READ_SLOW_LINK_RATE")) / 10,
    [["limits", /per second, the largest valid write takes ([\d.]+) s\./]],
  ],
  [
    "the large reads of one user in an hour",
    () => limitMax("SSO_LARGE_READ_PER_USER"),
    [
      ["limits", /and starts at most (\d+) in an hour/],
      ["limits", /by up to \d+ s, (\d+) times per hour/],
      ["limits", /the user half of the body budget at most (\d+) times/],
      // The residual of the spend of slow reads (ruling 79).
      ["limits", /\d+ accounts at (\d+) times \d+ s, \d+ s, held the user half/],
      ["limits", /If each of its (\d+) reads ends so/],
    ],
  ],
  [
    "the window of the large reads of one user, in seconds",
    () => limitSeconds("SSO_LARGE_READ_PER_USER"),
    [["limits", /takes \d+ reads, (\d+) s \/ \d+ s, from/]],
  ],
  [
    // The spend lands in the window in which the read ends, so the wait is up to a window (ruling 84 Low 1).
    "the window of the large reads of one user, in hours",
    () => limitSeconds("SSO_LARGE_READ_PER_USER") / 3600,
    [
      ["errors", /window ends, up to (\d+) hour from the end of that read/],
      ["limits", /window ends, up to (\d+) hour from the end of that read/],
    ],
  ],
  [
    "the reads within the time of no spend that hold the user half for the hour",
    slowReads,
    [["limits", /a hold for the hour takes (\d+) reads/]],
  ],
  [
    "the accounts of those reads, at 6 starts each",
    () => Math.ceil(slowReads() / limitMax("SSO_LARGE_READ_PER_USER")),
    [["limits", /\d+ s \/ \d+ s, from (\d+) accounts/]],
  ],
  [
    "the password sign-ups of one IP in an hour",
    signUpsPerIpHour,
    [["limits", /At (\d+) password sign-ups per IP per hour/]],
  ],
  [
    "the IPs of those accounts",
    () =>
      Math.ceil(Math.ceil(slowReads() / limitMax("SSO_LARGE_READ_PER_USER")) / signUpsPerIpHour()),
    [["limits", /per IP per hour, they come from (\d+) IPs/]],
  ],
  [
    "the upload of those reads, in MiB",
    () => slowReads() * capMiB(),
    [["limits", /so the hour takes about (\d+) MiB of upload/]],
  ],
  [
    "the reads of one account before its last read of a window",
    () => limitMax("SSO_LARGE_READ_PER_USER") - 1,
    [["limits", /holds the half for (\d+) times \d+ s and/]],
  ],
  [
    "the seconds that one account holds the user half in a window",
    holdOfAccount,
    [["limits", /times \d+ s and \d+ s, (\d+) s, in a window/]],
  ],
  [
    "the least accounts that hold the user half for the hour",
    leastAccounts,
    [["limits", /the least for the hour is (\d+) accounts/]],
  ],
  [
    "the reads of the least accounts",
    () => leastAccounts() * limitMax("SSO_LARGE_READ_PER_USER"),
    [["limits", /the least for the hour is \d+ accounts with (\d+) reads/]],
  ],
  [
    "the IPs of the least accounts",
    () => Math.ceil(leastAccounts() / signUpsPerIpHour()),
    [["limits", /\d+ reads, from (\d+) IPs, with/]],
  ],
  [
    "the upload of the least accounts, in MiB",
    () => leastAccounts() * limitMax("SSO_LARGE_READ_PER_USER") * capMiB(),
    [["limits", /IPs, with about (\d+) MiB of upload/]],
  ],
  [
    "the accounts whose 6 holds each fill the hour, before the spend of slow reads",
    accountsOfHolds,
    [["limits", /Before the spend of slow reads, (\d+) accounts at/]],
  ],
  [
    "the seconds of the holds of those accounts",
    () => accountsOfHolds() * limitMax("SSO_LARGE_READ_PER_USER") * ssoWriteSeconds(),
    [["limits", /accounts at \d+ times \d+ s, (\d+) s, held the user half/]],
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
      ["deploy", /while that caller sends (\d+) (MiB) each \d+ s/],
      ["readme", /One IP holds at most (\d+) (MiB)/],
      ["routes", /One IP holds at most (\d+) bytes, and so does the one client with no IP/],
    ],
  ],
];

/**
 * The sentences of ruling 84 Low 1, word for word, with the times that each
 * page states them. A write with a declared length that cannot start answers
 * 503 before any count of its user (rr-bodycap789 p1). A write with no length
 * counts at its start and can get the 503 at its first chunk (p9). A slow read
 * spends at each end, a 503 in the middle of the read too (p2, p2b). The spend
 * lands in the window in which the read ends (p8).
 */
const NARROWED: [FileKey, string, number][] = [
  [
    "errors",
    "An SSO connection write with a declared length that cannot start gets this code before any count of its user.",
    1,
  ],
  [
    "errors",
    "A write with no length counts at its start, and can then get this code at its first chunk.",
    1,
  ],
  ["errors", "A write that gets this code in the middle of its read has counted too.", 1],
  [
    "errors",
    "A write whose read ran more than 8 s before this code spends the rest of the window of `sso-large-read:user`.",
    1,
  ],
  [
    "errors",
    "An SSO connection write whose read ran more than 8 s before this code spends the rest of the window of `sso-large-read:user`.",
    1,
  ],
  ["errors", "So does such a write whose read ran more than 8 s and then ended in another way.", 1],
  [
    "errors",
    "The read can end whole, at a 413 past its cap, at a 503 `body_busy`, or at a closed socket.",
    1,
  ],
  ["errors", "The spend lands in the window in which the read ends.", 1],
  ["errors", "So a read that ends after its window ended fills the next window.", 1],
  [
    "errors",
    "Until that window ends, up to 1 hour from the end of that read, both SSO connection writes of the user answer 429 `rate_limited`.",
    1,
  ],
  // In BODY_CAPS, the two SSO connection writes, the create and the update, have a cap above the
  // floor. `POST /sso/connections/delete` has none. So only the two writes count on
  // `sso-large-read:user` (12l follow-up (12)).
  [
    "limits",
    "`POST /sso/connections/create` and `POST /sso/connections/update`, at the start of their body read, after `sso-manage:user` and the manager guard.",
    1,
  ],
  [
    "limits",
    "A write with a declared length whose read cannot start answers 503 `body_busy` before this count and `sso-manage:user`, and counts on neither.",
    1,
  ],
  [
    "limits",
    "A write with no length counts at its start, and can then get that 503 at its first chunk.",
    1,
  ],
  [
    "limits",
    "A write with a declared length that gets that 503 before its read starts counts on no limit of its user.",
    1,
  ],
  [
    "limits",
    "So an admin who sends such a write again after `Retry-After` loses no write of the hour.",
    1,
  ],
  [
    "limits",
    "A write with no length counts at its start, and can then get the 503 at its first chunk.",
    1,
  ],
  [
    "limits",
    "It spends at each end: whole, a 408, a 413 past its cap, a 503 in the middle of the read, and a closed socket.",
    2,
  ],
  ["limits", "The spend lands in the window in which the read ends.", 2],
  ["limits", "So a read that ends after its window ended fills the next window.", 2],
  [
    "limits",
    "The account then starts no large read until the window ends, up to 1 hour from the end of that read.",
    2,
  ],
];

/** A promise that a 503 costs a write no count of its user (ruling 84 Low 1). */
const NO_COUNT = /counts on (no limit|neither)|before any count/;

/** The plan of the body limits: each page that states them cites it (spec 18 rule 4, ruling 64 Low 3). */
const PLAN = "docs/superpowers/plans/2026-10-14-12j-release-program.md";
const PLAN_PAGES = [
  FILES.errors,
  FILES.limits,
  FILES.express,
  FILES.fastify,
  FILES.scim,
  FILES.deploy,
  FILES.sveltekit,
  `${DOCS}docs/reference/routes.md`,
  `${DOCS}docs/reference/api.md`,
];

/** The cap numbers that a file may state only where a fact holds them. */
const CAP_NUMBERS = /\b(65536|262144|8388608|16777216)\b/g;

describe("the request body limits of core and the docs (rulings 43, 46, 51, 56, 59, 66, 69, 72, 75, 79, and 84 of the 12j lane)", () => {
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

  it("states the 503 and the spend of an SSO connection write as core measures them (ruling 84 Low 1)", () => {
    for (const [file, sentence, times] of NARROWED) {
      const got = textOf(FILES[file]).split(sentence).length - 1;
      expect({ file, sentence, got }).toEqual({ file, sentence, got: times });
    }
  });

  it("promises no count at a 503 only to a write with a declared length (ruling 84 Low 1)", () => {
    for (const file of Object.keys(FILES) as FileKey[])
      for (const sentence of textOf(FILES[file]).split(/(?<=\.) (?=[A-Z])/))
        if (NO_COUNT.test(sentence))
          expect({ file, sentence, declared: sentence.includes("with a declared length") }).toEqual(
            {
              file,
              sentence,
              declared: true,
            },
          );
  });

  it("states the key of no IP and of a text that is not an IP as ipKey gives them (ruling 69)", () => {
    const limits = textOf(FILES.limits);
    const noIp = /A request with no client IP keys `([^`]+)`\./.exec(limits)?.[1];
    const text = /A value that is not an IP keys `([^`]+)` and the value/.exec(limits)?.[1];
    expect({ noIp, text: `${text}x` }).toEqual({ noIp: ipKey(null), text: ipKey("x") });
  });

  it("cites plan 12j in the sources of each page that states a body limit (ruling 64 Low 3)", () => {
    for (const page of PLAN_PAGES) {
      const head = readFileSync(page, "utf8").split("\n---\n")[0] ?? "";
      const cites = head.split("\n").some((line) => line.startsWith(`  - ${PLAN}`));
      expect({ page: page.slice(DOCS.length), cites }).toEqual({
        page: page.slice(DOCS.length),
        cites: true,
      });
    }
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

describe("the order of an SSO connection write (plan 12l)", () => {
  it("states on each page that the manager guard runs before the body read", () => {
    for (const [file, re] of [
      [
        "routes",
        // The two writes by name: the delete reads its body first (rr-final M1).
        /`POST \/sso\/connections\/create` and `POST \/sso\/connections\/update` name their organization or their connection in the query\. So the manager guard runs before their body read\. Each of the two then counts on /,
      ],
      [
        "limits",
        // Each refusal of such an account comes before any byte, not only the 403 (rr-task6 Low 2).
        /An account that manages no organization starts no large read\. `POST \/sso\/connections\/create` and `POST \/sso\/connections\/update` refuse each of its writes before any byte\. The refusal is the 403 of the manager guard, or an earlier one, such as 401, 503, 429, 400, or 404\./,
      ],
      [
        "readme",
        /name their organization or connection in the query, so the manager guard runs before the body read/,
      ],
    ] as const)
      expect(textOf(FILES[file]), file).toMatch(re);
  });

  it("names the four writes that check before the read, and the floor reads that come first (rr-final M1)", () => {
    // The delete and the domain writes name their row in the body, so they run managedCall:
    // the read, then the guard. They have no cap of their own in BODY_CAPS, so the floor bounds the read.
    expect(source).not.toMatch(/"POST \/sso\/(connections\/delete|domains\/[a-z]+)":/);
    const kib = constant("BODY_CAP_FLOOR") / 1024;
    for (const [file, sentence] of [
      [
        FILES.routes,
        `\`POST /sso/connections/delete\` and the domain writes read their body first, at most ${kib} KiB, and then run the manager guard.`,
      ],
      [
        FILES.limits,
        `\`POST /sso/connections/delete\` reads its body first, at most ${kib} KiB, and then runs the manager guard. A read at the floor holds no half of the body budget.`,
      ],
      [
        COMPAT_README,
        "Four SSO connection writes check the caller before they read the body (plan 12l). They are core's `POST /sso/connections/create` and `POST /sso/connections/update`, `/sso/register`, and `/sso/update-provider`.",
      ],
      [
        COMPAT_README,
        `\`/sso/delete-provider\` and core's \`POST /sso/connections/delete\` read their body first, at most ${kib} KiB, and then run the guard.`,
      ],
    ] as const)
      expect(textOf(file), file).toContain(sentence);
  });

  // The version branch deletes each changeset. There the summary counts a skip (ruling 70 of plan 12j).
  it.skipIf(!existsSync(WRITE_ORDER_CHANGESET))(
    "names the two writes and the floor read of the delete in the changeset of plan 12l (rr-final M1)",
    () => {
      const kib = constant("BODY_CAP_FLOOR") / 1024;
      const text = textOf(WRITE_ORDER_CHANGESET);
      for (const sentence of [
        "An account that manages no organization reads no large body: each of its writes to these two routes gets a refusal before any byte.",
        `\`POST /sso/connections/delete\` reads its body first, at most ${kib} KiB, and then runs the manager guard.`,
      ])
        expect(text).toContain(sentence);
    },
  );

  it("states that the body of /sso/update-provider names a provider, not the organization (rr-final L1)", () => {
    const text = textOf(COMPAT_README);
    for (const sentence of [
      "The body of `/sso/register` names the organization. The body of `/sso/update-provider` names a provider, and the organization comes from the connection of that provider. So the shim cannot know the organization before the read. Before their read, these two paths run a pre-check of the guard",
      "Core's guard then runs once after the read, for the organization of the body or of the provider.",
    ])
      expect(text).toContain(sentence);
  });

  it("states the member rows of the SSO pre-check as guard.ts bounds them (rr-final L2)", () => {
    const guard = readFileSync(GUARD, "utf8");
    // The read of the pre-check takes the constant as its limit, so the page states the bound of the code.
    expect(guard).toContain("{ limit: SSO_PRECHECK_MEMBER_ROWS }");
    const rows = constant("SSO_PRECHECK_MEMBER_ROWS", guard);
    expect(textOf(FILES.limits)).toContain(
      `Through the compatibility package, \`/sso/register\` and \`/sso/update-provider\` run a pre-check of the manager guard before their read. The pre-check reads at most ${rows} member rows of the caller, the first that the storage gives. A caller who is no platform operator, with no row of the owner rank among them, gets 403 before the read. An owner whose row is past those rows can still write through \`POST /sso/connections/create\` and \`POST /sso/connections/update\`, because their query names the row.`,
    );
  });

  it("states the order in the errors cell and the client paragraph of Task 6 (ruling 25)", () => {
    // The Routes cell of `second_factor_required`: one cell, so no `|` between the routes and it.
    expect(errorSection("second_factor_required")).toMatch(
      /\| [^|]*The two connection writes answer it before any byte of the body\. \|/,
    );
    // The client README holds the same paragraph (12l follow-up 10, plan 12n).
    for (const file of [FILES.client, `${REPO}packages/client/README.md`])
      expect(textOf(file), file).toMatch(
        /`sso\.connections\.create` sends `organizationId` in the query, and `sso\.connections\.update` sends `id` in the query\. The body holds the other fields\. Core runs the manager guard before it reads the body\./,
      );
  });

  it("states the two limits of an SSO manager on the routes page as routes/sso.ts holds them (rr-task6 Low 3)", () => {
    const text = textOf(FILES.routes);
    for (const [key, name] of [
      ["sso-manage:user", "SSO_MANAGE_PER_USER"],
      ["sso-large-read:user", "SSO_LARGE_READ_PER_USER"],
    ] as const) {
      // The page states a limit as `<key>:<userId>`, N per hour, or N per M minutes.
      const re = new RegExp(`\`${key}:<userId>\`, (\\d+) per (?:(\\d+) )?(minute|hour)s?\\b`, "g");
      const got = [...text.matchAll(re)].map((m) => ({
        max: Number(m[1]),
        seconds: Number(m[2] ?? 1) * (UNIT_SECONDS[m[3] ?? ""] ?? 0),
      }));
      expect({ key, stated: got.length > 0 }).toEqual({ key, stated: true });
      for (const limit of got)
        expect({ key, ...limit }).toEqual({
          key,
          max: limitMax(name),
          seconds: limitSeconds(name),
        });
    }
  });

  it("states the check after the read on the routes page (rulings 17, 23, and 31)", () => {
    // The session first, then the one right that the guard checked for the actor (ruling 31).
    expect(textOf(FILES.routes)).toMatch(
      /and reads its body last\. Before the act, it checks again that the session is live, and that the caller still holds the right that the guard checked\. For a caller that the guard accepted as a platform operator, that right is the platform role\. For any other caller, it is the owner rank of the organization\./,
    );
  });

  it("states the 401 of the check after the read in the unauthorized cell (rulings 23 and 31)", () => {
    // The Routes cell of `unauthorized`: one cell, so no `|` between the routes and it.
    expect(errorSection("unauthorized")).toMatch(
      /\| [^|]*The SSO connection writes \[`POST \/sso\/connections\/create`\]\(\/docs\/reference\/routes\/#post-sso-connections-create\) and \[`POST \/sso\/connections\/update`\]\(\/docs\/reference\/routes\/#post-sso-connections-update\) also answer it after the body read, when the session ended during the read\. \|/,
    );
  });

  it("lists each SSO route of forbidden_rank in its errors cell, with the order of the two writes (rr-task6 Low 1)", () => {
    const cell = errorSection("forbidden_rank");
    // The routes page holds the Errors cell of each route to core (check-routes).
    const ids = ssoRoutesAnswering("forbidden_rank");
    expect(ids.length > 0, "the routes page names no SSO route of forbidden_rank").toBe(true);
    for (const id of ids)
      expect({ id, linked: cell.includes(`(/docs/reference/routes/#${id})`) }).toEqual({
        id,
        linked: true,
      });
    // The guard answers it before any byte. The check after the read answers it too (ruling 17).
    // That check reads the session first, and a revoke of the role ends the sessions (ruling 31).
    expect(cell).toMatch(
      /\| [^|]*The two SSO connection writes answer it before any byte of the body\. After the read, they check the caller again\. An owner who lost the owner rank gets it then\. A platform operator who lost the platform role usually gets 401 \[`unauthorized`\]\(#unauthorized\), because a revoke of the role ends the operator's sessions\. If a removal of the role keeps the session live, the operator gets 403 `forbidden_rank`\. \|/,
    );
  });
});

// Plan 12n, follow-ups 1, 4, 10, and 13 of plan 12l. Each sentence on the SSO
// bounds and counts is held to the constant or to the order of its code.
describe("the SSO bounds and counts of the docs (plan 12n)", () => {
  const shim = readFileSync(`${REPO}packages/compat-better-auth/src/server/sso-routes.ts`, "utf8");

  it("states the large read count after sso-manage:user and the manager guard, in the order of routes/sso.ts", () => {
    const calls = [
      "await ssoManageAllowed(config",
      "await guard(organizationId)",
      "await ssoLargeReadAllowed(config",
    ].map((call) => ({ call, at: ssoSource.indexOf(call) }));
    for (const { call, at } of calls)
      expect(at, `${call} is not in routes/sso.ts`).toBeGreaterThan(-1);
    expect([...calls].sort((a, b) => a.at - b.at).map((c) => c.call)).toEqual(
      calls.map((c) => c.call),
    );
    expect(textOf(FILES.limits)).toMatch(
      /\| `sso-large-read:user:<userId>` \| [^|]*\| [^|]*\| [^|]*after `sso-manage:user` and the manager guard\./,
    );
  });

  it("states the two bounds of member rows in the compat README, as guard.ts and the shim hold them", () => {
    const precheck = constant("SSO_PRECHECK_MEMBER_ROWS", readFileSync(GUARD, "utf8"));
    const max = /^const PROVIDER_ORGANIZATIONS_MAX = (\d+);$/m.exec(shim)?.[1];
    if (max === undefined) throw new Error("no PROVIDER_ORGANIZATIONS_MAX in sso-routes.ts");
    // The member read of GET /sso/providers takes the constant as its limit.
    expect(shim).toContain("{ limit: PROVIDER_ORGANIZATIONS_MAX }");
    const text = textOf(COMPAT_README);
    expect(text).toContain(
      `The caller must be a platform operator, or hold the owner rank in the first ${precheck} member rows that the storage gives. An owner whose row is past those rows gets 403 here, and can write through core's paths \`POST /sso/connections/create\` and \`POST /sso/connections/update\`.`,
    );
    expect(text).toContain(
      `| \`GET /sso/providers\` | \`GET /sso/connections\` and \`GET /sso/domains\` of each organization that the caller manages. The shim reads at most ${max} member rows of the caller, the first that the storage gives. It lists the connections of those organizations only. |`,
    );
  });

  it("states the three counts of a register by a platform operator, with the operator limit of guards.ts", () => {
    const guards = readFileSync(`${REPO}packages/core/src/engine/operator/guards.ts`, "utf8");
    const max = /export const OPERATOR_PER_USER = \{ seconds: 3600, max: (\d+) \};/.exec(
      guards,
    )?.[1];
    if (max === undefined) throw new Error("no hourly OPERATOR_PER_USER in guards.ts");
    expect(textOf(COMPAT_README)).toContain(
      `A \`/sso/register\` of a platform operator counts \`operator:user\` three times, one per core write: the create, the domain add, and the domain update. Each write runs core's guard. So the ${max} calls of an hour give ${Number(max) / 3} registers.`,
    );
    expect(textOf(FILES.limits)).toContain(
      `| \`operator:user:<userId>\` | 1 hour | ${max} | Every call of a platform operator, after the operator user guard passes. A \`/sso/register\` of the compatibility package counts three times, one per core write |`,
    );
  });
});
