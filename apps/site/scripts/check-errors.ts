import { bodyCapOf } from "@authtempo/core/bindings";
import { ROUTER_CODES, type RouteKey } from "@authtempo/core/routes";
import { errorAnchor, routeAnchor } from "./lib/anchors.ts";
import { cellText, h3Headings } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The fields of a route entry that the Routes cell of a code reads. */
export interface RouteCodes {
  method: string;
  path: string;
  codes: readonly string[];
  oauthCodes: readonly string[];
}

/**
 * The codes that the router answers and no entry of ROUTES declares, with the
 * reason (decision 4 of plan 12n). Their cells come from the router rules and
 * `BODY_CAPS`, so the Routes rules leave them out. Core exports ROUTER_CODES
 * only. So the four other names are written here, as core names them.
 * LARGE_READ_CODES holds the cells of two of them.
 */
export const ROUTER_LEVEL: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    ROUTER_CODES.map((code) => [code, "ROUTER_CODES of core; the router answers it on each route"]),
  ),
  host_not_allowed: "HOST_CODE of core; the router answers it while baseURL is a list",
  body_too_large: "BODY_CODE of core; the router answers it past the body cap of a route",
  body_busy: "BUSY_CODE of core; the router answers it for a large read past the budget",
  body_timeout: "TIMEOUT_CODE of core; the router answers it for a large read past its deadline",
};

/**
 * The cells that the Routes rules do not hold, by anchor, with the reason
 * (decision 4 of plan 12n). Any other cell holds every route that declares
 * its code.
 */
export const EXEMPT_CELLS: Readonly<Record<string, string>> = {
  impersonation_session:
    "a paragraph names its routes by kind; check-routes holds the code in the Errors cell of each route",
};

/**
 * The links of a Routes cell to a route that does not declare the code, by
 * anchor and route. Each entry has its reason (decision 4 of plan 12n). Each
 * one is a prose mention, not a route of the code.
 */
export const MENTIONS: readonly { anchor: string; route: string; why: string }[] = [
  {
    anchor: "session_not_fresh",
    route: "POST /reauth",
    why: "the cell names the route that makes the session fresh",
  },
  {
    anchor: "email_mismatch",
    route: "POST /social/:provider/link",
    why: "the cell names the start of the link flow; its callbacks answer the code",
  },
  {
    anchor: "identity_taken",
    route: "POST /social/:provider/link",
    why: "the cell names the start of the link flow; its callbacks answer the code",
  },
];

/**
 * The router-level codes whose Routes cell lists each route that reads a body
 * above the floor. Ruling 36 of plan 12n adds this rule, and it narrows
 * decision 4. Only those routes answer the two codes. So the cell must name
 * each one, and no other route. A route in a code span counts as named.
 */
export const LARGE_READ_CODES: readonly string[] = ["body_busy", "body_timeout"];

/**
 * The routes that read a body above the floor with no entry of BODY_CAPS, with
 * the reason. `bodyCapOf` of core gives each other such route.
 */
export const LARGE_FORM_READS: Readonly<Record<string, string>> = {
  "POST /sso/:connectionId/acs":
    "acsForm of core reads the SAML form up to SAML_FORM_MAX, above the floor, against the budget of the large reads",
};

/** Each route that reads a body above the floor, as `<METHOD> <path>`, in the order of ROUTES. */
export function largeReads(routes: readonly RouteCodes[]): string[] {
  // bodyCapOf gives the floor to a route with no entry of BODY_CAPS.
  const floor = bodyCapOf(undefined);
  return routes
    .map((x) => `${x.method} ${x.path}`)
    .filter((key) => key in LARGE_FORM_READS || bodyCapOf(key as RouteKey) > floor);
}

/** The anchor of a route that a cell or a list names as `<METHOD> <path>`. */
export function anchorOf(route: string): string {
  const [method = "", path = ""] = route.split(" ");
  return routeAnchor(method, path);
}

/** The anchor of each route that declares `code` in `table`, in the order of ROUTES. */
export function routesOf(
  code: string,
  table: "core" | "oauth",
  routes: readonly RouteCodes[],
): string[] {
  return routes
    .filter((r) => (table === "core" ? r.codes : r.oauthCodes).includes(code))
    .map((r) => routeAnchor(r.method, r.path));
}

/** The one cell of the Routes table of each h3 with an id, up to the next h2 or h3. */
function routesCells(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<h3\b[^>]*\sid="([^"]+)"[^>]*>[\s\S]*?<\/h3>/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const next = /<h[23]\b/.exec(html.slice(start));
    const part = html.slice(start, next ? start + next.index : html.length);
    for (const t of part.matchAll(/<table>([\s\S]*?)<\/table>/g)) {
      const head = /<thead>([\s\S]*?)<\/thead>/.exec(t[1] ?? "")?.[1] ?? "";
      if (cellText(head) !== "Routes") continue;
      const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(t[1] ?? "")?.[1] ?? "";
      out.set(m[1] ?? "", /<td[^>]*>([\s\S]*?)<\/td>/.exec(body)?.[1] ?? "");
      break;
    }
  }
  return out;
}

/**
 * Every code of ERRORS and of OAUTH_ERRORS has an h3 anchor on the error page
 * whose heading states its status, and every h3 anchor names a code. Spec 18,
 * the error-page rule.
 *
 * The third table is STORAGE_ERROR_CODES (plan 12g, ruling 1 of its lane): the
 * codes of `StorageError`. A storage code has no HTTP status, so its heading
 * states none. Its anchor is the code, as for ERRORS. A code in both tables
 * fails, because one page cannot hold one id twice.
 *
 * The Routes cell of each code of ERRORS and of OAUTH_ERRORS holds to ROUTES
 * (12i follow-up (1), decision 4 of plan 12n). It links each route whose
 * `codes` or `oauthCodes` names the code, and no other route. A cell "The
 * routes of" another code holds when the two codes have one route set.
 * ROUTER_LEVEL, EXEMPT_CELLS, and MENTIONS hold the exemptions and the reasons.
 * A cell links each route once. The cells of LARGE_READ_CODES name each route
 * of `largeReads`, and no other route (ruling 36 of plan 12n).
 * check-routes holds the other direction: the Errors cell of each route.
 */
export function checkErrors(
  html: string,
  core: Readonly<Record<string, number>>,
  oauth: Readonly<Record<string, number>>,
  storage: readonly string[],
  routes: readonly RouteCodes[],
): CheckReport {
  const headings = h3Headings(html);
  const r: CheckReport = {
    name: "check-errors",
    counts: {
      codes: Object.keys(core).length + Object.keys(oauth).length + storage.length,
      anchors: headings.length,
      cells: 0,
      links: 0,
    },
    failures: [],
    exempt: [],
  };
  const expected = new Map<string, { code: string; status: number; table: string }>();
  for (const [code, status] of Object.entries(core))
    expected.set(errorAnchor(code, "core"), { code, status, table: "ERRORS" });
  for (const [code, status] of Object.entries(oauth))
    expected.set(errorAnchor(code, "oauth"), { code, status, table: "OAUTH_ERRORS" });
  const seen = new Map(headings.map((h) => [h.id, h.text]));
  for (const [id, e] of expected) {
    const text = seen.get(id);
    if (text === undefined) {
      r.failures.push(
        `${e.table === "ERRORS" ? "core" : "oauth"} code ${e.code} has no anchor #${id}`,
      );
      continue;
    }
    const status = /\s(\d{3})$/.exec(text)?.[1];
    if (status === undefined)
      r.failures.push(`#${id} states no status; ${e.table} says ${e.status}`);
    else if (status !== String(e.status))
      r.failures.push(`#${id} says status ${status}; ${e.table} says ${e.status}`);
  }
  const storageIds = new Set<string>();
  for (const code of storage) {
    const id = errorAnchor(code, "core");
    if (expected.has(id)) {
      r.failures.push(`storage code ${code} is also in ERRORS; the anchor #${id} cannot be both`);
      continue;
    }
    storageIds.add(id);
    const text = seen.get(id);
    if (text === undefined) r.failures.push(`storage code ${code} has no anchor #${id}`);
    else if (text.trim() !== code)
      r.failures.push(`#${id} must state the code ${code} only; a storage code has no status`);
  }
  for (const h of headings)
    if (!expected.has(h.id) && !storageIds.has(h.id))
      r.failures.push(`anchor #${h.id} names no code`);
  routeFailures(r, html, expected, routes);
  return requireCounts(r, ["codes", "anchors", "cells", "links"]);
}

/** The Routes rules of checkErrors: each cell against ROUTES, with the exemptions. */
function routeFailures(
  r: CheckReport,
  html: string,
  expected: ReadonlyMap<string, { code: string; table: string }>,
  routes: readonly RouteCodes[],
): void {
  const names = new Map(
    routes.map((x) => [routeAnchor(x.method, x.path), `${x.method} ${x.path}`]),
  );
  const nameOf = (a: string) => names.get(a) ?? `#${a}`;
  const tableOf = (t: string) => (t === "ERRORS" ? "core" : "oauth");
  // A route that declares a router-level code would make its cell drift unseen.
  for (const x of routes)
    for (const code of x.codes)
      if (code in ROUTER_LEVEL)
        r.failures.push(
          `${x.method} ${x.path} declares the router-level code ${code}; no entry may declare it`,
        );
  const cells = routesCells(html);
  const ids = new Set(h3Headings(html).map((h) => h.id));
  const large = largeReads(routes);
  for (const [id, e] of expected) {
    const cell = cells.get(id);
    if (cell === undefined) {
      // A code with no heading already failed above.
      if (ids.has(id)) r.failures.push(`#${id} has no Routes cell`);
      continue;
    }
    r.counts.cells = (r.counts.cells ?? 0) + 1;
    const routerLevel = e.table === "ERRORS" ? ROUTER_LEVEL[e.code] : undefined;
    if (routerLevel !== undefined) {
      const largeCell = LARGE_READ_CODES.includes(e.code);
      const rule = largeCell ? `; LARGE_READ_CODES holds its cell to ${large.length} routes` : "";
      r.exempt?.push(`#${id}: router-level, ${routerLevel}${rule}`);
      if (largeCell) largeReadFailures(r, id, cell, large);
      continue;
    }
    const why = EXEMPT_CELLS[id];
    if (why !== undefined) {
      r.exempt?.push(`#${id}: ${why}`);
      continue;
    }
    const want = routesOf(e.code, tableOf(e.table), routes);
    const linked = [...cell.matchAll(/href="\/docs\/reference\/routes\/#([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    r.counts.links = (r.counts.links ?? 0) + linked.length;
    // As check-routes does for an Errors cell, a cell links each route once (ruling 36 of plan 12n).
    for (const a of new Set(linked))
      if (linked.indexOf(a) !== linked.lastIndexOf(a))
        r.failures.push(`#${id}: the Routes cell links ${nameOf(a)} more than once`);
    // "The routes of [`x`](#x)." holds when x has the route set of this code.
    const cross = /^The routes of <a href="#([^"]+)">/.exec(cell.trim())?.[1];
    let held = linked;
    let through = "";
    if (linked.length === 0 && cross !== undefined) {
      const target = expected.get(cross);
      if (target === undefined) {
        r.failures.push(`#${id}: the Routes cell names the routes of #${cross}, which is no code`);
        continue;
      }
      held = routesOf(target.code, tableOf(target.table), routes);
      through = ` (it names the routes of #${cross})`;
    }
    for (const a of want)
      if (!held.includes(a))
        r.failures.push(
          `#${id}: the Routes cell lacks ${nameOf(a)}, which answers ${e.code}${through}`,
        );
    const mentions = MENTIONS.filter((m) => m.anchor === id);
    for (const a of new Set(held)) {
      if (want.includes(a)) continue;
      const mention = mentions.find((m) => anchorOf(m.route) === a);
      if (mention !== undefined)
        r.exempt?.push(`#${id}: ${mention.route} is a mention, ${mention.why}`);
      else
        r.failures.push(
          `#${id}: the Routes cell links ${nameOf(a)}, which does not answer ${e.code}${through}`,
        );
    }
    // A mention that no longer matches a link of the page exempts nothing, so it fails.
    for (const m of mentions) {
      if (!held.includes(anchorOf(m.route)))
        r.failures.push(
          `#${id}: MENTIONS names ${m.route}, and the cell does not link it; remove the entry`,
        );
      else if (want.includes(anchorOf(m.route)))
        r.failures.push(
          `#${id}: MENTIONS names ${m.route}, and the route declares ${e.code}; remove the entry`,
        );
    }
  }
}

/** The rule of LARGE_READ_CODES: the routes in the code spans of the cell are `large`. */
function largeReadFailures(
  r: CheckReport,
  id: string,
  cell: string,
  large: readonly string[],
): void {
  const named = [...cell.matchAll(/<code[^>]*>([A-Z]+ \/[^<]*)<\/code>/g)].map((m) => m[1] ?? "");
  for (const route of large)
    if (!named.includes(route))
      r.failures.push(`#${id}: the Routes cell lacks ${route}, which reads a body above the floor`);
  for (const route of new Set(named))
    if (!large.includes(route))
      r.failures.push(
        `#${id}: the Routes cell names ${route}, which reads no body above the floor`,
      );
}
