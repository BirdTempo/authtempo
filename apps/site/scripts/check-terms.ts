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

/**
 * The words a reader reads: a link target, a bare URL, an autolink, a code
 * span, and a double-quoted name are not prose, so they are removed.
 */
function readable(text: string): string {
  return text
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/<https?:[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/"[^"]*"/g, " ");
}

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
    const sourceLines = p.source.split("\n");
    const units: { text: string; line: number }[] = proseUnits(fm.body, fm.bodyLine);
    // Headings, table rows, raw <h3> headings, and aside titles hold prose
    // that proseUnits skips as markup. A <code> span of a raw heading is code,
    // as a backtick span is, so it is removed with the tags.
    let fence = false;
    fm.body.split("\n").forEach((raw, i) => {
      const t = raw.trim();
      const line = fm.bodyLine + i;
      if (/^(```|~~~)/.test(t)) fence = !fence;
      else if (fence) return;
      else if (/^(#|\|)/.test(t)) units.push({ text: t, line });
      else if (/^<h3[\s>]/.test(t))
        units.push({
          text: t.replace(/<code>[\s\S]*?<\/code>/g, " ").replace(/<[^>]+>/g, " "),
          line,
        });
      else {
        const aside = /^:::[a-z]+\[(.*)\]/.exec(t);
        if (aside) units.push({ text: aside[1] ?? "", line });
      }
    });
    for (const key of ["title", "description"] as const) {
      const text = fm.fields[key];
      if (text) {
        const at = sourceLines.findIndex((l) => l.startsWith(`${key}:`));
        units.push({ text, line: at + 1 });
      }
    }
    for (const unit of units) {
      r.counts.units = (r.counts.units ?? 0) + 1;
      const text = readable(unit.text);
      for (const t of FORBIDDEN_TERMS) {
        const m = t.pattern.exec(text);
        if (m) r.failures.push(`${p.path}:${unit.line}: "${m[0]}" is forbidden; write "${t.use}"`);
      }
    }
  }
  // A missing glossary or term already fails above, so "terms" is not required here.
  return requireCounts(r, ["pages", "units"]);
}
