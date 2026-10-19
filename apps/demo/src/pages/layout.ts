import type { RouteFeature } from "@authtempo/core/routes";
import { DOCS_BASE } from "../facts.js";
import { type Html, html } from "../html.js";
import type { DemoMail } from "../mail.js";

/** The state of a sandbox that a page shows. */
export interface PageState {
  /** The time of the reset, in ms since the epoch: create() writes it into demo_meta. */
  resetAt: number;
  /** The mails of the sandbox, newest first. */
  mail: readonly DemoMail[];
  /** The demo origin, so the mailbox makes a link of each URL of this origin only. */
  origin: string;
}

export interface DemoPage {
  path: string;
  title: string;
  /** The feature of core that the page shows, or null for a page of the demo itself. */
  feature: RouteFeature | null;
  /** The docs page of the feature: an absolute URL on authtempo.com. */
  guide: string;
}

/** The pages of the demo, in the order of the header list. */
export const DEMO_PAGES = [
  { path: "/", title: "authtempo demo", feature: null, guide: `${DOCS_BASE}/start/` },
  {
    path: "/password",
    title: "Password",
    feature: "password",
    guide: `${DOCS_BASE}/guides/password/`,
  },
  {
    path: "/magic-link",
    title: "Magic link",
    feature: "magicLink",
    guide: `${DOCS_BASE}/guides/magic-link/`,
  },
  {
    path: "/email-code",
    title: "Email code",
    feature: "emailOtp",
    guide: `${DOCS_BASE}/guides/email-code/`,
  },
  {
    path: "/passkey",
    title: "Passkey",
    feature: "passkey",
    guide: `${DOCS_BASE}/guides/passkeys/`,
  },
  {
    path: "/social",
    title: "Social sign-in",
    feature: "social",
    guide: `${DOCS_BASE}/guides/social/`,
  },
  {
    path: "/second-factor",
    title: "Second factor",
    feature: "totp",
    guide: `${DOCS_BASE}/guides/second-factor/`,
  },
  {
    path: "/tokens",
    title: "API tokens",
    feature: "tokens",
    guide: `${DOCS_BASE}/guides/api-tokens/`,
  },
  {
    path: "/organizations",
    title: "Organizations",
    feature: "organizations",
    guide: `${DOCS_BASE}/guides/organizations/`,
  },
  { path: "/mailbox", title: "Mailbox", feature: null, guide: `${DOCS_BASE}/reference/config/` },
] as const satisfies readonly DemoPage[];

export type DemoPath = (typeof DEMO_PAGES)[number]["path"];

/** Decision 4 of 2026-10-14: each password form holds this line. */
export const COST_LINE =
  "The demo hashes each password with 1000 PBKDF2 iterations so it runs on Workers Free. A real deployment uses 100000.";

export interface Field {
  name: string;
  label: string;
  type: "email" | "password" | "text";
  autocomplete?: string;
  optional?: true;
}

/**
 * One call form of a method page. The page script reads `data-call` and
 * makes the call. The form posts to its own page when no script runs, so a
 * password never goes into a URL. A form with a password field is followed
 * by the cost line.
 */
export function callForm(
  call: string,
  legend: string | null,
  fields: readonly Field[],
  submit: string,
): Html {
  const inputs = fields.map(
    (f) =>
      html`<label>${f.label}${f.optional ? " (optional)" : ""} <input type="${f.type}" name="${f.name}"${f.autocomplete ? html` autocomplete="${f.autocomplete}"` : ""}${f.optional ? "" : html` required`}></label>`,
  );
  // A password form needs a username field for a password manager and for
  // accessibility (Chrome 155 logs a [DOM] notice otherwise). An email field
  // serves; with none, the form gets a hidden one.
  const password = fields.some((f) => f.type === "password");
  const username =
    password && !fields.some((f) => f.type === "email")
      ? html`<input type="email" name="username" autocomplete="username" hidden>`
      : "";
  const form = html`<form class="call" method="post" data-call="${call}">${legend === null ? "" : html`<h2>${legend}</h2>`}${username}${inputs}<button type="submit">${submit}</button></form>`;
  if (!password) return form;
  return html`${form}<p class="cost">${COST_LINE}</p>`;
}

/** The time of the reset in UTC, as "HH:MM UTC". */
function utcTime(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

/** The name of a page script: the file /assets/js/<name>.js of the browser build. */
const SCRIPT_RE = /^[a-z][a-z-]*$/;

/** The blocks that each method page shows after its forms: the session, the last call, and the guide. */
function methodParts(entry: DemoPage): Html {
  return html`<section class="session"><h2>Your session</h2><div class="row">${callForm("session", null, [], "Read the session")}${callForm("sign-out", null, [], "Sign out")}</div></section>
<section class="exchange" aria-live="polite"><h2>The last call</h2><pre id="exchange">No call yet.</pre></section>
<p class="guide"><a href="${entry.guide}">Read the guide of this method</a></p>`;
}

/**
 * One page of the demo: the layout around the body. The layout holds the
 * viewport, the two style sheets, the header with the page list, the test
 * data line, and the reset form. The Worker adds the page headers.
 */
export function page(input: {
  title: string;
  path: string;
  resetAt: number;
  body: Html;
  script: string | null;
}): Response {
  const { title, path, resetAt, body, script } = input;
  if (script !== null && !SCRIPT_RE.test(script))
    throw new Error(`demo: bad script name ${script}`);
  const entry: DemoPage | undefined = DEMO_PAGES.find((p) => p.path === path);
  const nav = DEMO_PAGES.map(
    (p) =>
      html`<li><a href="${p.path}"${p.path === path ? html` aria-current="page"` : ""}>${p.path === "/" ? "Home" : p.title}</a></li>`,
  );
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title === "authtempo demo" ? title : `${title} - authtempo demo`}</title>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/demo.css">
${script === null ? "" : html`<script type="module" src="/assets/js/${script}.js"></script>`}
</head>
<body>
<header class="top"><a class="brand" href="/">authtempo demo</a><nav aria-label="Demo pages"><ul>${nav}</ul></nav></header>
<main>
<p class="notice">Test data only. Do not use a real password. Everything is deleted at <time datetime="${new Date(resetAt).toISOString()}">${utcTime(resetAt)}</time>.</p>
<form class="reset" method="post" action="/reset"><button type="submit">Start again</button></form>
<h1>${title}</h1>
${body}
${entry !== undefined && entry.feature !== null ? methodParts(entry) : ""}
</main>
</body>
</html>
`;
  return new Response(doc.__html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** The body of one page and the name of its script, or null for a page with no script. */
export interface PageBody {
  script: string | null;
  body(state: PageState): Html;
}
