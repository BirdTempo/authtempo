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

  it("fails when the glossary is missing", () => {
    expect(checkTerms([body("Sign in.")]).failures).toEqual([
      "docs/reference/glossary.md is missing",
    ]);
  });
});
