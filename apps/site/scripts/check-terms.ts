import { type Page, parseFrontmatter, proseUnits } from "./lib/markdown.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/**
 * The forbidden synonyms of spec 18, each with its approved term. The
 * glossary page lists every `term` in a code span; the check holds the two
 * lists together. A code span and a double-quoted name are exempt.
 */
export const FORBIDDEN_TERMS: readonly { term: string; pattern: RegExp; use: string }[] = [
  { term: "log in", pattern: /\blog(?:s|ged|ging)? in\b/i, use: "sign in" },
  { term: "login", pattern: /\blog-?ins?\b/i, use: "sign in" },
  { term: "logon", pattern: /\blogons?\b/i, use: "sign in" },
  { term: "log out", pattern: /\blog(?:s|ged|ging)? out\b/i, use: "sign out" },
  { term: "logout", pattern: /\blog-?outs?\b/i, use: "sign out" },
  { term: "API key", pattern: /\bAPI[ -]keys?\b/i, use: "API token" },
  { term: "2FA", pattern: /\b2FA\b/i, use: "second factor" },
  { term: "MFA", pattern: /\bMFA\b/i, use: "second factor" },
  { term: "two-factor", pattern: /\btwo[- ]factor\b/i, use: "second factor" },
  { term: "OTP", pattern: /\bOTPs?\b/i, use: "email code" },
  { term: "WebAuthn credential", pattern: /\bWebAuthn credentials?\b/i, use: "passkey" },
  { term: "session id", pattern: /\bsession ids?\b/i, use: "session token" },
  { term: "session key", pattern: /\bsession keys?\b/i, use: "session token" },
  {
    term: "email verification token",
    pattern: /\bemail verification tokens?\b/i,
    use: "proof of an address",
  },
  { term: "IdP", pattern: /\bIdPs?\b/i, use: "provider" },
  { term: "identity provider", pattern: /\bidentity providers?\b/i, use: "provider" },
];

const GLOSSARY = "docs/reference/glossary.md";

export function checkTerms(pages: readonly Page[]): CheckReport {
  const r: CheckReport = {
    name: "check-terms",
    counts: { pages: pages.length, units: 0, terms: 0 },
    failures: [],
  };
  const glossary = pages.find((p) => p.path === GLOSSARY);
  if (!glossary) r.failures.push(`${GLOSSARY} is missing`);
  else
    for (const t of FORBIDDEN_TERMS) {
      if (glossary.source.includes(`\`${t.term}\``)) r.counts.terms = (r.counts.terms ?? 0) + 1;
      else r.failures.push(`the glossary lacks the forbidden term \`${t.term}\``);
    }
  for (const p of pages) {
    const fm = parseFrontmatter(p.source);
    if (!fm) continue;
    for (const unit of proseUnits(fm.body, fm.bodyLine)) {
      r.counts.units = (r.counts.units ?? 0) + 1;
      const text = unit.text.replace(/`[^`]*`/g, " ").replace(/"[^"]*"/g, " ");
      for (const t of FORBIDDEN_TERMS) {
        const m = t.pattern.exec(text);
        if (m) r.failures.push(`${p.path}:${unit.line}: "${m[0]}" is forbidden; write "${t.use}"`);
      }
    }
  }
  // A missing glossary or term already fails above, so "terms" is not required here.
  return requireCounts(r, ["pages", "units"]);
}
