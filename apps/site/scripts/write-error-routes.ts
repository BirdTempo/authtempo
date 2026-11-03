// Decision 4 of plan 12n (12i follow-up (1)). This script writes the Routes
// cell of a code on the errors page from ROUTES, so a new route needs no hand
// edit. check-errors holds each cell to ROUTES after the build.
//
//   node apps/site/scripts/write-error-routes.ts [--write] [anchor ...]
//
// With anchors, it prints the cell of each one. With no anchor, it prints the
// cell of each code whose links differ from ROUTES. With --write, it writes
// those cells into the page and prints the count.
//
// The form is the form of the cells today. A cell starts with a list of links
// in the order of ROUTES, then its closing prose, if any. A link that the prose
// holds stays in the prose, and the list leaves it out. A cell that starts
// with prose keeps it whole after the list. The exempt cells of check-errors,
// the router-level codes, and a cell "The routes of" another code stay as
// they are.
import { readFileSync, writeFileSync } from "node:fs";
import { ROUTES } from "@authtempo/core/routes";
import { anchorOf, EXEMPT_CELLS, MENTIONS, ROUTER_LEVEL, routesOf } from "./check-errors.ts";
import { DOCS } from "./lib/paths.ts";

const PAGE = `${DOCS}docs/reference/errors.md`;
const LINK = /\[`([A-Z]+ [^`]+)`\]\(\/docs\/reference\/routes\/#([^)]+)\)/g;
const LEADING_LIST =
  /^\[`[A-Z]+ [^`]+`\]\(\/docs\/reference\/routes\/#[^)]+\)(?:, \[`[A-Z]+ [^`]+`\]\(\/docs\/reference\/routes\/#[^)]+\))*/;
const CROSS = /^The routes of \[`[a-z_]+`\]\(#[a-z_-]+\)\.$/;

const names = new Map(
  ROUTES.map((r) => [anchorOf(`${r.method} ${r.path}`), `${r.method} ${r.path}`]),
);

/** The Markdown link of a route, as the cells write it. */
function linkOf(anchor: string): string {
  return `[\`${names.get(anchor) ?? anchor}\`](/docs/reference/routes/#${anchor})`;
}

/** The text of a Routes cell for `anchor`, from ROUTES and the prose of the cell today. */
function cellOf(anchor: string, body: string): string {
  const oauth = anchor.startsWith("oauth-");
  const code = oauth ? anchor.slice("oauth-".length) : anchor;
  const head = LEADING_LIST.exec(body)?.[0] ?? "";
  const rest = body.slice(head.length);
  // A list ends at the end, at its full stop, or at a comma before its prose.
  const listCell = head !== "" && (rest === "" || rest.startsWith(".") || rest.startsWith(","));
  const prose = listCell ? rest : body;
  const inProse = new Set([...prose.matchAll(LINK)].map((m) => m[2] ?? ""));
  const list = routesOf(code, oauth ? "oauth" : "core", ROUTES)
    .filter((a) => !inProse.has(a))
    .map(linkOf);
  if (listCell) {
    if (list.length === 0) throw new Error(`#${anchor}: no route stays before the prose`);
    return `${list.join(", ")}${rest}`;
  }
  return list.length === 0 ? body : `${list.join(", ")}. ${body}`;
}

/** True when the route links of a cell differ from ROUTES, past the named mentions. */
function differs(anchor: string, body: string): boolean {
  const oauth = anchor.startsWith("oauth-");
  const code = oauth ? anchor.slice("oauth-".length) : anchor;
  const want = new Set(routesOf(code, oauth ? "oauth" : "core", ROUTES));
  const mentions = new Set(
    MENTIONS.filter((m) => m.anchor === anchor).map((m) => anchorOf(m.route)),
  );
  const linked = new Set([...body.matchAll(LINK)].map((m) => m[2] ?? ""));
  for (const a of want) if (!linked.has(a)) return true;
  for (const a of linked) if (!want.has(a) && !mentions.has(a)) return true;
  return false;
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const named = args.filter((a) => a !== "--write");
const lines = readFileSync(PAGE, "utf8").split("\n");
let anchor: string | null = null;
let changed = 0;
for (let i = 0; i < lines.length; i++) {
  const h = /^<h3 id="([^"]+)">/.exec(lines[i] ?? "");
  if (h) {
    anchor = h[1] ?? null;
    continue;
  }
  if (lines[i] !== "| Routes |" || anchor === null) continue;
  const at = anchor;
  anchor = null;
  const row = lines[i + 2] ?? "";
  if (!row.startsWith("| ") || !row.endsWith(" |")) throw new Error(`#${at}: no Routes row`);
  const body = row.slice(2, -2);
  const kept =
    (!at.startsWith("oauth-") && at in ROUTER_LEVEL) || at in EXEMPT_CELLS || CROSS.test(body);
  if (named.length > 0 ? !named.includes(at) : kept || !differs(at, body)) continue;
  const cell = kept ? row : `| ${cellOf(at, body)} |`;
  if (!write) console.log(`#${at}\n${cell}\n`);
  else if (cell !== row) {
    lines[i + 2] = cell;
    changed++;
  }
}
if (write) {
  writeFileSync(PAGE, lines.join("\n"));
  console.log(`write-error-routes: wrote ${changed} cells of ${PAGE.slice(DOCS.length)}`);
}
