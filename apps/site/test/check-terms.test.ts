import { describe, expect, it } from "vitest";
import { checkTerms, FORBIDDEN_TERMS } from "../scripts/check-terms.ts";

const glossary = {
  path: "docs/reference/glossary.md",
  source: `---\ntitle: G\n---\n| Term | Do not write |\n| --- | --- |\n${FORBIDDEN_TERMS.map((t) => `| x | \`${t.term}\` |`).join("\n")}\n`,
};
const body = (text: string) => ({ path: "docs/a.md", source: `---\ntitle: A\n---\n${text}\n` });

describe("checkTerms", () => {
  it("passes the approved terms and ignores code spans, fences, and quoted names", () => {
    const r = checkTerms([
      glossary,
      body(
        'Sign in with a passkey. The code `login_required` stays.\n\n```text\nlog in\n```\n\nThe product "Sign In with LinkedIn" stays.',
      ),
    ]);
    expect(r.failures).toEqual([]);
    expect(r.counts.pages).toBe(2);
    expect(r.counts.terms).toBe(FORBIDDEN_TERMS.length);
  });

  it("refuses a forbidden term and names the line and the approved term", () => {
    const r = checkTerms([glossary, body("First line.\n\nThe person can log in with a code.")]);
    expect(r.failures).toEqual(['docs/a.md:6: "log in" is forbidden; write "sign in"']);
  });

  it("refuses OTP and two-factor in prose, and passes TOTP", () => {
    const r = checkTerms([glossary, body("Turn on TOTP. Send an OTP. Use two-factor.")]);
    // The failures follow the order of FORBIDDEN_TERMS: two-factor comes before OTP.
    expect(r.failures).toEqual([
      'docs/a.md:4: "two-factor" is forbidden; write "second factor"',
      'docs/a.md:4: "OTP" is forbidden; write "email code"',
    ]);
  });

  it("refuses a glossary that lacks a forbidden term", () => {
    const short = { ...glossary, source: glossary.source.replace("| x | `OTP` |\n", "") };
    expect(checkTerms([short, body("Sign in.")]).failures).toEqual([
      "the glossary lacks the forbidden term `OTP`",
    ]);
  });

  it("refuses a glossary word that FORBIDDEN_TERMS lacks", () => {
    const more = { ...glossary, source: `${glossary.source}| x | \`re-auth\` |\n` };
    expect(checkTerms([more, body("Sign in.")]).failures).toEqual([
      "the glossary forbids `re-auth`, which FORBIDDEN_TERMS lacks",
    ]);
  });

  it("reads only the last column, so a forbidden term in a meaning cell does not count", () => {
    const moved = {
      ...glossary,
      source: glossary.source.replace("| x | `OTP` |", "| `OTP` | x |"),
    };
    expect(checkTerms([moved, body("Sign in.")]).failures).toEqual([
      "the glossary lacks the forbidden term `OTP`",
    ]);
  });

  it("ignores link targets, bare URLs, and autolinks", () => {
    const r = checkTerms([
      glossary,
      body(
        "Read [the guide](/docs/guides/two-factor/) or https://x.com/login or <https://x.com/log-in>.",
      ),
    ]);
    expect(r.failures).toEqual([]);
  });

  it("refuses a forbidden term in a heading", () => {
    expect(checkTerms([glossary, body("## Log in with a passkey")]).failures).toEqual([
      'docs/a.md:4: "Log in" is forbidden; write "sign in"',
    ]);
  });

  it("refuses a forbidden term in a table cell", () => {
    expect(
      checkTerms([glossary, body("| A | B |\n| --- | --- |\n| x | can log in |")]).failures,
    ).toEqual(['docs/a.md:6: "log in" is forbidden; write "sign in"']);
  });

  it("refuses a forbidden term in a raw <h3> heading and in an aside title", () => {
    const r = checkTerms([
      glossary,
      body('<h3 id="x">Log in <code>login</code></h3>\n\n:::caution[Set up MFA]\nText.\n:::'),
    ]);
    // The <code> span holds "login" too; it is code, so only "Log in" fails.
    expect(r.failures).toEqual([
      'docs/a.md:4: "Log in" is forbidden; write "sign in"',
      'docs/a.md:6: "MFA" is forbidden; write "second factor"',
    ]);
  });

  it("refuses a forbidden term in the frontmatter title and description", () => {
    const page = {
      path: "docs/a.md",
      source: "---\ntitle: Log in\ndescription: Set up MFA.\n---\nText.\n",
    };
    expect(checkTerms([glossary, page]).failures).toEqual([
      'docs/a.md:2: "Log in" is forbidden; write "sign in"',
      'docs/a.md:3: "MFA" is forbidden; write "second factor"',
    ]);
  });

  it("fails when the glossary is missing", () => {
    expect(checkTerms([body("Sign in.")]).failures).toEqual([
      "docs/reference/glossary.md is missing",
    ]);
  });
});
