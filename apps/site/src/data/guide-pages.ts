import type { IdpGuide, SpField } from "@authtempo/core";

// Plan 13a Task 15. One page for each IdP guide of GUIDES (core, sso/guides).
// The page is written from the record by scripts/write-guide-pages.ts, and
// check-guide-pages holds the file to the record. So the record is the one
// source: a text change in core shows as a red check until the pages are written again.

/** The start of each guide page name: `sso-setup-idp-<id>`. */
export const GUIDE_PAGE_PREFIX = "sso-setup-idp-";

/** The page of one guide, by its path from the docs folder. */
export function guidePagePath(id: string): string {
  return `docs/guides/${GUIDE_PAGE_PREFIX}${id}.md`;
}

/**
 * The sentence that each guide page holds. No owner has run a guide on a real
 * tenant yet (runbook, "Owner-run items of the enterprise setup"). When a
 * proof exists, change this one sentence with the proof, and write the pages again.
 */
export const NOT_CHECKED = "No label in this guide was checked on a real tenant.";

/** The name of each SP value in the prose of a page. */
const VALUE_NAMES: Record<SpField, string> = {
  acsUrl: "ACS URL",
  entityId: "SP entity ID",
  redirectUri: "redirect URI",
  scimBaseUrl: "SCIM base URL",
  scimToken: "SCIM token",
};

const KIND_NAMES = { saml: "SAML", oidc: "OIDC" } as const;

/**
 * A guide text has angle brackets, such as `/sso/<id>/start`. Markdown reads
 * them as a tag, so each word with a bracket goes in a code span. The dot or
 * comma at the end of a sentence stays outside the span.
 */
export function codeAngles(text: string): string {
  return text.replace(/[^\s"]*<[^<>]+>[^\s"]*/g, (word) => {
    const end = /[.,;:]+$/.exec(word)?.[0] ?? "";
    return `\`${word.slice(0, word.length - end.length)}\`${end}`;
  });
}

/**
 * The record keeps the words of the provider docs, such as "IdP". The site
 * writes the approved term (check-terms). A double-quoted name is a label, so
 * it stays as the provider writes it. The check applies this same function
 * to the record, so the page and the record agree.
 */
export function approved(text: string): string {
  return text
    .split(/("[^"]*")/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\b([Aa])n (?=IdP)/g, "$1 ")
            .replace(/\bIdP-initiated\b/gi, "provider-initiated")
            .replace(/\bIdPs\b/gi, "providers")
            .replace(/\bIdP\b/gi, "provider")
            .replace(/\blogin initiation\b/gi, "sign-in initiation"),
    )
    .join("");
}

/** The words that the setup page shows beside a step that has a value. */
function valueNote(field: SpField): string {
  return field === "scimToken"
    ? "The setup page shows the SCIM token one time."
    : `The setup page shows the ${VALUE_NAMES[field]}.`;
}

/** The mark of an unconfirmed label. The words are the words of the record. */
function mark(reason: string): string {
  return `**Unconfirmed:** ${codeAngles(approved(reason))}`;
}

/** The page of one guide, from its record. */
export function guidePageMarkdown(g: IdpGuide): string {
  const kinds = g.kinds.map((k) => KIND_NAMES[k]).join(" and ");
  const rows = (Object.keys(VALUE_NAMES) as SpField[]).map((f) => {
    const label = g.fields[f];
    return `| ${VALUE_NAMES[f]} | ${label === "" ? `none, ${g.name} has no field for it` : `"${label}"`} |`;
  });
  const steps = g.steps.map((s, i) => {
    const parts = [codeAngles(approved(s.text))];
    if (s.value !== undefined) parts.push(valueNote(s.value));
    if (s.unconfirmed !== undefined) parts.push(mark(s.unconfirmed));
    return `${i + 1}. ${parts.join(" ")}`;
  });
  const lines = [
    "---",
    `title: Set up ${g.name} for an SSO setup link`,
    `description: The steps in ${g.name} for the IT admin of a customer, read from the ${g.name} docs on ${g.checkedOn}.`,
    "type: how-to",
    "sources:",
    `  - packages/core/src/sso/guides/${g.id}.ts`,
    "  - packages/core/src/sso/guides/index.ts",
    "---",
    "",
    `**For:** the IT admin of a customer who sets up SSO in ${g.name} through a setup link.`,
    "",
    `**What it does:** this page gives the steps in ${g.name} for ${kinds}. It is the guide that the setup page shows. The guide was read from the ${g.name} docs on ${g.checkedOn}.`,
    "",
    "## Before you start",
    "",
    "- A setup link from the owner of the organization. Read [Set up SSO with a setup link](/docs/guides/sso-setup-link/) for the steps of the link.",
    "",
    "## What was checked",
    "",
    `Checked on: ${g.checkedOn}. A person read the ${g.name} docs on that day. ${g.name} can change its admin pages after that day. The release check of authtempo fails when a guide is older than 180 days.`,
    "",
    `${NOT_CHECKED} A step with an Unconfirmed mark is a step whose label the docs do not confirm. Check that label in your own tenant before you rely on it.`,
    "",
    `## The labels in ${g.name}`,
    "",
    "| Value | Label |",
    "| --- | --- |",
    ...rows,
    "",
    "## Steps",
    "",
    ...steps,
    "",
    "## Start a sign-in from the app tile",
    "",
    codeAngles(approved(g.launch)),
    ...(g.launchUnconfirmed === undefined ? [] : ["", mark(g.launchUnconfirmed)]),
    "",
    "## Directory sync with SCIM",
    "",
    g.directory === null
      ? `${g.name} sends no SCIM, so this guide has no directory step.`
      : codeAngles(approved(g.directory)),
    "",
    "## If it fails",
    "",
    "- A failed test run names the step that failed on the setup page. Read that step, then check the label in your tenant.",
    "- A link ends at its time, at a revoke, and at an activation. Ask the owner of the organization for a new link.",
    "",
    "## Next",
    "",
    "- [Set up SSO with a setup link](/docs/guides/sso-setup-link/)",
    "- [Setup link reference](/docs/reference/sso-setup/)",
    "",
  ];
  return lines.join("\n");
}
