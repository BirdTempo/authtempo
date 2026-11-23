import type { ResolvedConfig } from "../config.js";
import type { ErrorCode } from "../errors.js";
import type { SetupStep } from "../schema.js";
import { fillGuide, GUIDES, type IdpGuide, type SpField } from "../sso/guides/index.js";
import { escapeHtml } from "./confirm-page.js";
import type { SETUP_PAGE_STEPS } from "./contract/sso.js";

/** The pages of the setup. The list lives in the contract, so the query and this type share it. */
export type SetupPageStep = (typeof SETUP_PAGE_STEPS)[number];

/** The draft connection of the link, as the page shows it. It holds no secret. */
export interface DraftSummary {
  id: string;
  kind: "oidc" | "saml";
  label: string;
  /** Each change of the draft adds 1. A test pass binds to one version. */
  version: number;
  issuer: string | null;
  clientId: string | null;
  ssoUrl: string | null;
  idpEntityId: string | null;
}

/**
 * The last test run of the draft, as the page shows it. `step`, `attributeNames`, `address`, and
 * `name` come from the IdP, so the page treats each as hostile text. `current` is false when the
 * run belongs to an older version of the draft.
 */
export interface TestSummary {
  outcome: "passed" | "failed" | "pending";
  step: string | null;
  help: string;
  attributeNames: string[];
  address: string | null;
  name: string | null;
  domainClaimed: boolean;
  current: boolean;
}

/** One domain that the link added. The record is null once the domain is verified. */
export interface SetupDomain {
  id: string;
  domain: string;
  verified: boolean;
  record: { name: string; type: "TXT"; value: string } | null;
}

/**
 * What a setup page gets (plan 13a Task 9). `values` holds the real SP values of the draft, or an
 * empty text for each value that does not exist yet. `csrf` is a value that only this setup
 * session can compute. Core does not print it in its own forms: the router checks Origin and
 * Fetch Metadata on each POST (the rule of the other pages of core). It is for an app page that
 * wants its own token.
 */
export interface SetupPageInput {
  step: SetupPageStep;
  csrf: string;
  link: {
    organization: string;
    note: string;
    steps: SetupStep[];
    kinds: ("oidc" | "saml")[];
  };
  guide: IdpGuide | null;
  values: Record<SpField, string>;
  draft: DraftSummary | null;
  test: TestSummary | null;
  error: ErrorCode | null;
  domains: SetupDomain[];
  /** The pending SCIM token of the link: its hint, never the token. Null: none yet. */
  scim: { hint: string } | null;
}

/** The steps that a link shows, in the order of the flow. The hand back is always there. */
export function stepsOfLink(steps: readonly SetupStep[]): SetupPageStep[] {
  const out: SetupPageStep[] = [];
  if (steps.includes("connection")) out.push("idp");
  if (steps.includes("domain")) out.push("domain");
  if (steps.includes("connection")) out.push("connect", "test");
  if (steps.includes("directory")) out.push("directory");
  out.push("handback");
  return out;
}

const TITLES: Record<SetupPageStep, string> = {
  idp: "Choose your IdP",
  domain: "Prove your domain",
  connect: "Connect",
  test: "Test",
  directory: "Directory",
  handback: "Hand back",
  confirm: "Done",
};

const STYLE = `body { font-family: system-ui, sans-serif; margin: 0; background: #f6f6f6; color: #111; }
main { background: #fff; margin: 2rem auto; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); max-width: 44rem; }
nav ol { display: flex; flex-wrap: wrap; gap: 0.75rem; padding: 0; list-style: none; }
nav li.here a { font-weight: bold; }
p.small, dd, .mark { font-size: 0.875rem; }
p.small { color: #555; }
p.mark { color: #7a4b00; }
p.alert { color: #8a1c1c; font-weight: bold; }
code { background: #f1f1f1; padding: 0 0.25rem; word-break: break-all; }
label { display: block; margin: 0.75rem 0; }
input[type=text], input[type=password], textarea { display: block; width: 100%; font: inherit; box-sizing: border-box; }
button, a.button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; text-decoration: none; display: inline-block; }`;

/** A step of a guide that starts with a kind: "For SAML, ...". A step with no kind holds for each kind. */
const KIND_PREFIX = /^For (SAML|OIDC|SCIM), /;

/** The kind that a guide step names, or null for a step that holds for each kind. */
export function guideStepKind(text: string): "saml" | "oidc" | "scim" | null {
  const m = KIND_PREFIX.exec(text);
  return m?.[1] === undefined ? null : (m[1].toLowerCase() as "saml" | "oidc" | "scim");
}

function url(config: ResolvedConfig, path: string): string {
  return escapeHtml(`${config.basePath}${path}`);
}

function mark(reason: string | undefined): string {
  if (reason === undefined) return "";
  return `<p class="mark"><strong>Unconfirmed:</strong> ${escapeHtml(reason)} Check this in your own IdP before you rely on it.</p>`;
}

function guideSteps(input: SetupPageInput, scim: boolean): string {
  const { guide, draft } = input;
  if (guide === null) return "";
  const kind = draft?.kind ?? null;
  const rows = guide.steps.flatMap((s) => {
    const k = guideStepKind(s.text);
    if (scim ? k !== "scim" : k === "scim" || (k !== null && kind !== null && k !== kind))
      return [];
    const label = s.value === undefined ? "" : guide.fields[s.value];
    const value = s.value === undefined ? "" : input.values[s.value];
    const shown =
      s.value === undefined
        ? ""
        : value === ""
          ? s.value === "scimToken"
            ? `<p class="small">The page shows the token once, when you create it.</p>`
            : ""
          : `<p class="small">${escapeHtml(label === "" ? "Value" : label)}: <code>${escapeHtml(value)}</code></p>`;
    return [`<li><p>${escapeHtml(s.text)}</p>${shown}${mark(s.unconfirmed)}</li>`];
  });
  return rows.length === 0 ? "" : `<ol>\n${rows.join("\n")}\n</ol>`;
}

function guideHead(input: SetupPageInput): string {
  const { guide } = input;
  if (guide === null) return "";
  return `<h2>${escapeHtml(guide.name)}</h2>\n<p class="small">Guide checked on ${escapeHtml(guide.checkedOn)}.</p>`;
}

function launchBlock(config: ResolvedConfig, input: SetupPageInput): string {
  const { guide, draft } = input;
  if (guide === null || draft === null) return "";
  const filled = fillGuide(config, guide, draft.id);
  return `<h3>Start a sign-in from the app tile of the IdP</h3>\n<p>${escapeHtml(filled.launch)}</p>\n${mark(guide.launchUnconfirmed)}`;
}

/** One text input. A password input has no `value` attribute: core never prints a secret. */
function field(label: string, name: string, value: string, type = "text"): string {
  const attr = type === "password" ? "" : ` value="${escapeHtml(value)}"`;
  return `<label>${escapeHtml(label)}<input type="${type}" name="${name}"${attr} required></label>`;
}

function connectForms(config: ResolvedConfig, input: SetupPageInput): string {
  const { draft, guide, link } = input;
  let kinds = link.kinds;
  if (draft !== null) kinds = [draft.kind];
  else if (guide !== null) {
    const both = link.kinds.filter((k) => guide.kinds.includes(k));
    if (both.length > 0) kinds = both;
  }
  const action = url(config, "/sso/setup/connection");
  return kinds
    .map((kind) => {
      const own = draft?.kind === kind ? draft : null;
      const body =
        kind === "oidc"
          ? [
              field("Issuer", "issuer", own?.issuer ?? ""),
              field("Client ID", "clientId", own?.clientId ?? ""),
              // Never filled: a setup session cannot read a secret that it wrote.
              field("Client secret", "clientSecret", "", "password"),
            ]
          : [
              `<label>IdP metadata (XML)<textarea name="idpMetadata" rows="8" required></textarea></label>`,
            ];
      return `<form method="post" action="${action}">
<h3>${kind === "oidc" ? "OIDC" : "SAML"} connection</h3>
<input type="hidden" name="kind" value="${kind}">
${field("Name of the connection", "label", own?.label ?? "")}
${body.join("\n")}
<button type="submit">Save</button>
</form>`;
    })
    .join("\n");
}

function draftBlock(input: SetupPageInput): string {
  const { draft, values } = input;
  if (draft === null) return `<p>No connection is saved yet.</p>`;
  const rows: [string, string][] = [
    ["Name", draft.label],
    ["Kind", draft.kind === "oidc" ? "OIDC" : "SAML"],
  ];
  if (draft.kind === "oidc") {
    rows.push(["Issuer", draft.issuer ?? ""], ["Client ID", draft.clientId ?? ""]);
    rows.push(["Redirect URI", values.redirectUri]);
  } else {
    rows.push(["IdP entity ID", draft.idpEntityId ?? ""], ["IdP sign-on URL", draft.ssoUrl ?? ""]);
    rows.push(["ACS URL", values.acsUrl], ["Entity ID", values.entityId]);
  }
  const list = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd><code>${escapeHtml(v)}</code></dd>`)
    .join("\n");
  return `<h3>Saved connection</h3>\n<dl>\n${list}\n</dl>`;
}

function idpPage(config: ResolvedConfig, input: SetupPageInput): string {
  const list = GUIDES.filter((g) => g.kinds.some((k) => input.link.kinds.includes(k)))
    .map(
      (g) =>
        `<li><a href="${url(config, `/sso/setup/status?step=connect&idp=${g.id}`)}">${escapeHtml(g.name)}</a></li>`,
    )
    .join("\n");
  return `<h2>Choose your IdP</h2>\n<p>Choose the product that holds the accounts of your company.</p>\n<ul>\n${list}\n</ul>`;
}

function domainPage(config: ResolvedConfig, input: SetupPageInput): string {
  const rows = input.domains
    .map((d) => {
      if (d.verified || d.record === null)
        return `<li><code>${escapeHtml(d.domain)}</code>: verified.</li>`;
      return `<li><code>${escapeHtml(d.domain)}</code>: not verified. Add this record at your DNS host.
<p class="small">Type: ${escapeHtml(d.record.type)}. Name: <code>${escapeHtml(d.record.name)}</code>. Value: <code>${escapeHtml(d.record.value)}</code></p>
<form method="post" action="${url(config, "/sso/setup/domains/verify")}">
<input type="hidden" name="id" value="${escapeHtml(d.id)}">
<button type="submit">Check the record</button>
</form></li>`;
    })
    .join("\n");
  return `<h2>Prove your domain</h2>
<p>Core trusts an email domain only when its DNS holds a record that core gives you.</p>
<ul>
${rows}
</ul>
<form method="post" action="${url(config, "/sso/setup/domains/add")}">
${field("Domain", "domain", "")}
<button type="submit">Add the domain</button>
</form>`;
}

function connectPage(config: ResolvedConfig, input: SetupPageInput): string {
  return `${guideHead(input)}
${guideSteps(input, false)}
${launchBlock(config, input)}
${draftBlock(input)}
${connectForms(config, input)}`;
}

function testPage(config: ResolvedConfig, input: SetupPageInput): string {
  const { draft, test } = input;
  if (draft === null)
    return `<h2>Test</h2>\n<p>Save the connection first. <a href="${url(config, "/sso/setup/status?step=connect")}">Go to the connection</a>.</p>`;
  const start = `<p><a class="button" href="${url(config, `/sso/${draft.id}/start?test=1`)}">Start the test</a></p>`;
  let result = "";
  if (test !== null) {
    const old = test.current
      ? ""
      : `<p class="mark">This result is for an older version of the connection. Test again after the change.</p>`;
    if (test.outcome === "passed") {
      const names =
        test.attributeNames.length === 0
          ? "none"
          : test.attributeNames.map((n) => `<code>${escapeHtml(n)}</code>`).join(", ");
      result = `<h3>The test passed</h3>
<p>Address: ${test.address === null ? "no longer held" : `<code>${escapeHtml(test.address)}</code>`}. Name: ${test.name === null ? "none" : `<code>${escapeHtml(test.name)}</code>`}.</p>
<p>The IdP sent these attributes: ${names}.</p>
<p>${test.domainClaimed ? "A verified domain of your organization claims this address." : "No verified domain of your organization claims this address."}</p>
${old}`;
    } else if (test.outcome === "failed") {
      result = `<h3>The test did not pass</h3>
<p>Step: <code>${escapeHtml(test.step ?? "")}</code></p>
<p>${escapeHtml(test.help)}</p>
${old}`;
    } else
      result = `<h3>The test is not finished</h3>\n<p>Start the test again if you left the sign-in.</p>`;
  }
  return `<h2>Test</h2>\n<p>The test signs you in at your IdP and checks the answer. It makes no user and no session.</p>\n${start}\n${result}`;
}

function directoryPage(config: ResolvedConfig, input: SetupPageInput): string {
  const { guide, scim, values } = input;
  const intro =
    guide === null ? "" : `<p>${escapeHtml(guide.directory ?? "This IdP does not send SCIM.")}</p>`;
  const token =
    scim === null
      ? "<p>No token yet.</p>"
      : `<p>A token exists. It ends with <code>${escapeHtml(scim.hint)}</code>. Create a new one to replace it.</p>`;
  return `<h2>Directory</h2>
${intro}
<p>SCIM base URL: <code>${escapeHtml(values.scimBaseUrl)}</code></p>
${guideSteps(input, true)}
${token}
<form method="post" action="${url(config, "/sso/setup/scim-token")}">
<button type="submit">Create a token</button>
</form>`;
}

function handbackPage(config: ResolvedConfig): string {
  return `<h2>Hand back</h2>
<p>When your work is done, hand the setup back. The owners of your organization get a message. They check the draft and make it live.</p>
<form method="post" action="${url(config, "/sso/setup/handback")}">
<button type="submit">Hand back to the owners</button>
</form>`;
}

function body(config: ResolvedConfig, input: SetupPageInput): string {
  switch (input.step) {
    case "idp":
      return idpPage(config, input);
    case "domain":
      return domainPage(config, input);
    case "connect":
      return connectPage(config, input);
    case "test":
      return testPage(config, input);
    case "directory":
      return directoryPage(config, input);
    case "handback":
      return handbackPage(config);
    case "confirm":
      return `<h2>Done</h2>\n<p>Your work is done. The owners of your organization have a message. You can close this page.</p>`;
  }
}

/**
 * The page of core: a header, the steps of the link, and the form or the text of one step.
 * The forms post to `/sso/setup/domains/add`, `domains/verify`, `connection`, `scim-token`, and
 * `handback`. Task 11 mounts these routes, and it must accept a form body and answer a form post
 * with a 303 or an HTML page. Until then a form of this page gets 404. The forms hold no csrf
 * value: the Origin and Fetch Metadata rules of the router do that check.
 */
export function defaultSetupPage(config: ResolvedConfig, input: SetupPageInput): string {
  const idp = input.guide === null ? "" : `&idp=${input.guide.id}`;
  const nav = stepsOfLink(input.link.steps)
    .map(
      (s) =>
        `<li${s === input.step ? ' class="here"' : ""}><a href="${url(config, `/sso/setup/status?step=${s}${idp}`)}">${TITLES[s]}</a></li>`,
    )
    .join("\n");
  const alert =
    input.error === null
      ? ""
      : `<p class="alert" role="alert">That did not work. Code: <code>${escapeHtml(input.error)}</code></p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>Set up single sign-on</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
<h1>Set up single sign-on</h1>
<p class="small">For ${escapeHtml(input.link.organization)}. Contact: ${escapeHtml(input.link.note)}.</p>
<nav><ol>
${nav}
</ol></nav>
${alert}
${body(config, input)}
</main>
</body>
</html>
`;
}

/** The HTML of a setup page: the page of the app when `sso.setup.page` is set, else the page of core. */
export function renderSetupPage(config: ResolvedConfig, input: SetupPageInput): string {
  const custom = config.sso?.setup ? config.sso.setup.page : null;
  return custom ? custom(input) : defaultSetupPage(config, input);
}
