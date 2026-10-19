import type { AuthForm } from "@authtempo/core/routes";
import { errorAnchor, routeAnchor } from "./lib/anchors.ts";
import { h3Headings, sectionOf } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The fields of a route entry that the page states. */
export interface RouteCells {
  method: string;
  path: string;
  auth: readonly string[];
  codes: readonly string[];
  oauthCodes: readonly string[];
}

/**
 * The words of each credential form at the start of a Needs cell (plan 11g).
 * Two forms join with "; or ", and a later form starts with a lower-case letter.
 * Text after the words and a full stop is free.
 */
export const AUTH_WORDS: Record<AuthForm, string> = {
  none: "Nothing",
  session: "A session cookie, or a ts_ bearer token",
  apiToken: "A tk_ bearer token",
  sessionJwt: "A session JWT as the bearer",
  accessToken: "An access token of the OAuth provider as the bearer",
  operator: "The operator secret",
  initialAccessToken: "The initial access token as the bearer",
};

/** The media word of an Input part, by the media types of the request body. */
const MEDIA_WORDS: Record<string, string> = {
  "application/json": "JSON",
  "application/json application/x-www-form-urlencoded": "JSON or form",
  "application/x-www-form-urlencoded": "Form",
};

const PART = /^(JSON or form|JSON|Form|Query) \{([^{}]*)\}/;

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function text(cell: string): string {
  return decode(cell.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** The rest of a cell after a prefix: "" at the end, the free text after ". ", or null. */
function after(cell: string, prefix: string): string | null {
  if (!cell.startsWith(prefix)) return null;
  const rest = cell.slice(prefix.length);
  if (rest === "") return "";
  return rest.startsWith(". ") ? rest.slice(2) : null;
}

/** The cells of the first table after each h3 with an id, by field name. */
function tablesOf(html: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const m of html.matchAll(/<h3\b[^>]*\sid="([^"]+)"[^>]*>[\s\S]*?<\/h3>/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const next = /<h[23]\b/.exec(html.slice(start));
    const part = html.slice(start, next ? start + next.index : html.length);
    const body = /<table>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(part)?.[1] ?? "";
    const rows = new Map<string, string>();
    for (const row of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...(row[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
        (c) => c[1] ?? "",
      );
      const [field, value] = cells;
      if (field !== undefined && value !== undefined) rows.set(text(field), value);
    }
    out.set(decode(m[1] ?? ""), rows);
  }
  return out;
}

/** The forms that a Needs cell names, in order, or null when the cell does not parse. */
function needsForms(cell: string): string[] | null {
  const forms: string[] = [];
  let rest = cell;
  for (;;) {
    const first = forms.length === 0;
    const hit = Object.entries(AUTH_WORDS)
      .map(([form, words]) => ({
        form,
        words: first ? words : `${words.charAt(0).toLowerCase()}${words.slice(1)}`,
      }))
      .filter((w) => rest.startsWith(w.words))
      .sort((a, b) => b.words.length - a.words.length)[0];
    if (hit === undefined) return null;
    forms.push(hit.form);
    rest = rest.slice(hit.words.length);
    if (rest.startsWith("; or ")) {
      rest = rest.slice("; or ".length);
      continue;
    }
    return after(rest, "") === null ? null : forms;
  }
}

/** The parts of an Input cell by kind (Query or body), or null when the cell does not parse. */
function inputParts(cell: string): Map<string, { word: string; keys: string[] }> | null {
  const parts = new Map<string, { word: string; keys: string[] }>();
  if (after(cell, "None") !== null) return parts;
  let rest = cell;
  for (;;) {
    const m = PART.exec(rest);
    if (!m) return null;
    const word = m[1] ?? "";
    const kind = word === "Query" ? "Query" : "body";
    if (parts.has(kind)) return null;
    const keys = (m[2] ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k !== "");
    parts.set(kind, { word, keys });
    rest = rest.slice(m[0].length);
    if (rest.startsWith("; ") && parts.size === 1) {
      rest = rest.slice(2);
      continue;
    }
    return after(rest, "") === null ? null : parts;
  }
}

/** The keys of an object schema: each name, with "?" when the schema does not require it. */
function schemaKeys(schema: unknown): string[] | null {
  const s = schema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  if (s?.properties === undefined) return null;
  return Object.keys(s.properties).map((k) => (s.required?.includes(k) ? k : `${k}?`));
}

/** The parts of an operation's input in the document, by kind, or null when it has no operation. */
function documentParts(
  doc: unknown,
  route: RouteCells,
): Map<string, { word: string; keys: string[] }> | null {
  const paths = (doc as { paths?: Record<string, Record<string, unknown>> }).paths ?? {};
  const op = paths[route.path.replace(":provider", "{provider}")]?.[route.method.toLowerCase()] as
    | {
        parameters?: { name: string; in: string; required?: boolean }[];
        requestBody?: { content: Record<string, { schema: unknown }> };
      }
    | undefined;
  if (op === undefined) return null;
  const parts = new Map<string, { word: string; keys: string[] }>();
  const query = (op.parameters ?? []).filter((p) => p.in === "query");
  if (query.length > 0)
    parts.set("Query", {
      word: "Query",
      keys: query.map((p) => (p.required === true ? p.name : `${p.name}?`)),
    });
  if (op.requestBody !== undefined) {
    const media = Object.keys(op.requestBody.content).sort();
    const schema = Object.values(op.requestBody.content)[0]?.schema;
    parts.set("body", {
      word: MEDIA_WORDS[media.join(" ")] ?? media.join(" "),
      keys: schemaKeys(schema) ?? ["(not an object)"],
    });
  }
  return parts;
}

function show(part: { word: string; keys: string[] }): string {
  return `${part.word} { ${part.keys.join(", ")} }`;
}

/** The failures of an Input cell against the document's parts. */
function inputFailures(
  name: string,
  page: Map<string, { word: string; keys: string[] }>,
  want: Map<string, { word: string; keys: string[] }>,
): string[] {
  const out: string[] = [];
  for (const kind of ["Query", "body"]) {
    const got = page.get(kind);
    const has = want.get(kind);
    const label = kind === "Query" ? "a Query part" : "a body part";
    if (got === undefined && has === undefined) continue;
    if (got === undefined && has !== undefined) {
      out.push(`${name}: Input has no ${label.slice(2)}; the document has ${show(has)}`);
      continue;
    }
    if (got !== undefined && has === undefined) {
      out.push(`${name}: Input has ${label}; the document has none`);
      continue;
    }
    if (got === undefined || has === undefined) continue;
    if (got.word !== has.word)
      out.push(`${name}: Input says ${got.word}; the document has ${has.word}`);
    const extra = got.keys.filter((k) => !has.keys.includes(k));
    const lacks = has.keys.filter((k) => !got.keys.includes(k));
    const said = [
      ...(extra.length > 0 ? [`Input names ${extra.join(", ")}`] : []),
      ...(lacks.length > 0 ? [`Input lacks ${lacks.join(", ")}`] : []),
    ];
    if (said.length > 0)
      out.push(`${name}: ${said.join("; ")}; the document has ${has.keys.join(", ")}`);
  }
  return out;
}

/** The h2 of the routes page that states the rules of every route. */
const RULES_HEADING = "The rules of every route";

/**
 * A rule that only the page states: the page has the Errors and Needs cells,
 * and the document has no cells.
 */
const PAGE_ONLY_RULE = /^The (?:Errors|Needs) cell /;

/** Text with straight quotes, because the site build writes curly ones outside code. */
function straight(s: string): string {
  return s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

/** The text of each item of the rules section of the page, or null with no section. */
function pageRules(html: string): string[] | null {
  const section = sectionOf(html, RULES_HEADING);
  if (section === null) return null;
  return [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => straight(text(m[1] ?? "")));
}

/** The text of each item of the list in the document's `info.description`, with no markdown. */
function documentRules(doc: unknown): string[] {
  const description = (doc as { info?: { description?: unknown } }).info?.description;
  if (typeof description !== "string") return [];
  return description
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) =>
      line
        .slice(2)
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/`/g, "")
        .trim(),
    );
}

/**
 * The document's rules and the page's rules are one list (plan 11g). Each rule
 * of the document is an item of the page. Each item of the page is a rule of
 * the document or a rule of the cells.
 */
function ruleFailures(html: string, doc: unknown): { held: number; failures: string[] } {
  const page = pageRules(html);
  if (page === null) return { held: 0, failures: [`the page has no section ${RULES_HEADING}`] };
  const want = documentRules(doc);
  if (want.length === 0) return { held: 0, failures: ["the document states no rule"] };
  const failures = [
    ...want
      .filter((rule) => !page.includes(rule))
      .map((rule) => `the page lacks the rule: ${rule}`),
    ...page
      .filter((rule) => !want.includes(rule) && !PAGE_ONLY_RULE.test(rule))
      .map((rule) => `the document lacks the rule: ${rule}`),
  ];
  return { held: want.filter((rule) => page.includes(rule)).length, failures };
}

/**
 * Every route of ROUTES has an h3 anchor whose heading names it, and every h3
 * anchor names a route. The table after each heading holds three cells to
 * the entry (plan 11g). Errors holds to `codes` and `oauthCodes`, Needs to
 * `auth`, and Input to the operation's query and body in the built document `doc`.
 * The rules section of the page holds the rules of the document's description.
 */
export function checkRoutes(
  html: string,
  routes: readonly RouteCells[],
  doc: unknown,
): CheckReport {
  const headings = h3Headings(html);
  const r: CheckReport = {
    name: "check-routes",
    counts: { routes: routes.length, anchors: headings.length, cells: 0, rules: 0 },
    failures: [],
  };
  if (doc === null || typeof doc !== "object")
    r.failures.push("the built document is missing or is not JSON, so no Input cell is read");
  const seen = new Map(headings.map((h) => [h.id, h.text]));
  const tables = tablesOf(html);
  const expected = new Set<string>();
  for (const route of routes) {
    const id = routeAnchor(route.method, route.path);
    expected.add(id);
    const heading = seen.get(id);
    const name = `${route.method} ${route.path}`;
    if (heading === undefined) {
      r.failures.push(`route ${name} has no anchor #${id}`);
      continue;
    }
    if (heading !== name) {
      r.failures.push(`#${id} names ${heading}; the route is ${name}`);
      continue;
    }
    const rows = tables.get(id) ?? new Map<string, string>();
    for (const field of ["Needs", "Input", "Errors"]) {
      const cell = rows.get(field);
      if (cell === undefined) {
        r.failures.push(`${name}: the table has no ${field} row`);
        continue;
      }
      const plain = text(cell);
      const unparsed = `${name}: the ${field} cell does not parse: ${plain}`;
      if (field === "Needs") {
        const forms = needsForms(plain);
        if (forms === null) r.failures.push(unparsed);
        else if (forms.join(", ") !== route.auth.join(", "))
          r.failures.push(
            `${name}: Needs names ${forms.join(", ")}; ROUTES says ${route.auth.join(", ")}`,
          );
        r.counts.cells = (r.counts.cells ?? 0) + 1;
      } else if (field === "Input") {
        if (doc === null || typeof doc !== "object") continue;
        const page = inputParts(plain);
        const want = documentParts(doc, route);
        if (page === null) r.failures.push(unparsed);
        else if (want === null) r.failures.push(`${name}: the document has no operation`);
        else r.failures.push(...inputFailures(name, page, want));
        r.counts.cells = (r.counts.cells ?? 0) + 1;
      } else {
        const linked = [...cell.matchAll(/href="\/docs\/reference\/errors\/#([^"]+)"/g)].map((m) =>
          decode(m[1] ?? ""),
        );
        if (linked.length === 0 && after(plain, "None") === null) r.failures.push(unparsed);
        else {
          const declared = [
            ...route.codes.map((c) => errorAnchor(c, "core")),
            ...route.oauthCodes.map((c) => errorAnchor(c, "oauth")),
          ];
          for (const a of declared)
            if (!linked.includes(a)) r.failures.push(`${name}: Errors lacks ${a}`);
          for (const a of new Set(linked))
            if (!declared.includes(a))
              r.failures.push(`${name}: Errors names ${a}; the route does not declare it`);
          for (const a of new Set(linked))
            if (linked.indexOf(a) !== linked.lastIndexOf(a))
              r.failures.push(`${name}: Errors links ${a} more than once`);
        }
        r.counts.cells = (r.counts.cells ?? 0) + 1;
      }
    }
  }
  for (const h of headings)
    if (!expected.has(h.id)) r.failures.push(`anchor #${h.id} names no route`);
  if (doc !== null && typeof doc === "object") {
    const rules = ruleFailures(html, doc);
    r.counts.rules = rules.held;
    r.failures.push(...rules.failures);
  }
  return requireCounts(r, ["routes", "anchors", "cells", "rules"]);
}
