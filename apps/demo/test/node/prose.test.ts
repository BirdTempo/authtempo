import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkClaims } from "../../../site/scripts/check-claims.ts";
import { checkSentences } from "../../../site/scripts/check-sentences.ts";
import { checkTerms } from "../../../site/scripts/check-terms.ts";
import type { Page } from "../../../site/scripts/lib/markdown.ts";
import { otherNames } from "../../../site/src/data/compare.ts";
import type { Html } from "../../src/html.ts";
import { DEMO_IDENTITIES, MAX_EMAIL } from "../../src/identities.ts";
import { DEMO_BODIES } from "../../src/pages/index.ts";
import { DEMO_PAGES, type PageState, page } from "../../src/pages/layout.ts";
import { PROVIDER_TITLE, providerBody } from "../../src/pages/provider.ts";
import { type Refusal, refusedPage } from "../../src/pages/refused.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const GLOSSARY_PATH = "docs/reference/glossary.md";
const ORIGIN = "https://demo.authtempo.com";

/**
 * A fixed sandbox state. The two mails are the texts of core's default mails
 * (src/engine/magic-link.ts and email-otp-mail.ts, read 2026-10-20), so the
 * mailbox page shows its real prose.
 */
const STATE: PageState = {
  resetAt: Date.UTC(2026, 9, 20, 10, 30),
  origin: ORIGIN,
  mail: [
    {
      id: 2,
      to: "pat@example.com",
      subject: "Your sign-in code for authtempo demo",
      text: "Your code is 123456. It is valid for 10 minutes. If you did not ask for it, ignore this message.",
      at: Date.UTC(2026, 9, 20, 9, 45),
    },
    {
      id: 1,
      to: "pat@example.com",
      subject: "Sign in to authtempo demo",
      text: `Open this link to sign in. It is valid for 15 minutes.\n\n${ORIGIN}/auth/magic-link/verify?token=ml_x\n\nIf you did not ask for it, ignore this message.`,
      at: Date.UTC(2026, 9, 20, 9, 40),
    },
  ],
};

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** The text that a reader reads, one paragraph per block element. */
function textOf(doc: string): string[] {
  return doc
    .replace(/<script\b[\s\S]*?<\/script>/g, "\n\n")
    .replace(
      /<\/?(?:html|head|body|title|header|nav|main|section|article|form|h1|h2|h3|p|ul|ol|li|label|button|pre|input|meta|link)\b[^>]*>/g,
      "\n\n",
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e)
    .split(/\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "" && s !== "<!doctype html>");
}

async function prosePage(title: string, path: string, body: Html, script: string | null) {
  const doc = await page({ title, path, resetAt: STATE.resetAt, body, script }).text();
  const paragraphs = textOf(doc);
  const source = `---\ntitle: ${title}\n---\n\n${paragraphs.join("\n\n")}\n`;
  return { path: `demo${path}`, source } satisfies Page;
}

describe("the prose of the demo pages", () => {
  it("keeps each page's prose to the term list and the sentence limits", async () => {
    const glossary: Page = {
      path: GLOSSARY_PATH,
      source: readFileSync(join(REPO, "apps/site/src/content/docs", GLOSSARY_PATH), "utf8"),
    };
    const pages: Page[] = [];
    for (const p of DEMO_PAGES) {
      const { body, script } = DEMO_BODIES[p.path];
      pages.push(await prosePage(p.title, p.path, body(STATE), script));
    }
    pages.push(
      await prosePage(
        PROVIDER_TITLE,
        "/provider/authorize",
        providerBody({
          action: "/provider/authorize",
          identities: DEMO_IDENTITIES,
          maxEmail: MAX_EMAIL,
        }),
        null,
      ),
    );
    // The pages of a refused view (final review Low 3).
    const refusals: Refusal[] = [
      "sandboxesPerIp",
      "sandboxesTotal",
      "requestsPerIpPerMinute",
      "cross_site",
    ];
    for (const r of refusals) {
      const doc = await refusedPage(429, r, STATE.resetAt).text();
      const source = `---\ntitle: ${r}\n---\n\n${textOf(doc).join("\n\n")}\n`;
      pages.push({ path: `demo/refused/${r}`, source });
    }
    expect(pages.length).toBe(15);
    for (const p of pages) {
      const terms = checkTerms([glossary, p]);
      expect(terms.failures, p.path).toEqual([]);
      expect(terms.counts.units ?? 0, p.path).toBeGreaterThan(0);
      const sentences = checkSentences([p]);
      expect(sentences.failures, p.path).toEqual([]);
      expect(sentences.counts.sentences ?? 0, p.path).toBeGreaterThan(0);
    }
  });

  it("makes no claim of the compare page on any demo page (spec 24 item 4)", async () => {
    // Final review m1 of plan 11b: the rule of check-claims, on the pages of the demo Worker.
    const docs = new Map<string, string>();
    for (const p of DEMO_PAGES) {
      const { body, script } = DEMO_BODIES[p.path];
      const doc = page({
        title: p.title,
        path: p.path,
        resetAt: STATE.resetAt,
        body: body(STATE),
        script,
      });
      docs.set(`demo${p.path}`, await doc.text());
    }
    const provider = providerBody({
      action: "/provider/authorize",
      identities: DEMO_IDENTITIES,
      maxEmail: MAX_EMAIL,
    });
    const chooser = page({
      title: PROVIDER_TITLE,
      path: "/provider/authorize",
      resetAt: 0,
      body: provider,
      script: null,
    });
    docs.set("demo/provider/authorize", await chooser.text());
    for (const r of [
      "sandboxesPerIp",
      "sandboxesTotal",
      "requestsPerIpPerMinute",
      "cross_site",
    ] as const)
      docs.set(`demo/refused/${r}`, await refusedPage(429, r, STATE.resetAt).text());
    const report = checkClaims({ pages: docs, names: otherNames() });
    expect(report.counts.pages).toBe(15);
    expect(report.failures).toEqual([]);
  });

  it("reads the text of the layout, the body, and a mail", async () => {
    const { body, script } = DEMO_BODIES["/mailbox"];
    const p = await prosePage("Mailbox", "/mailbox", body(STATE), script);
    expect(p.source).toContain(
      "\n\nTest data only. Do not use a real password. Everything is deleted at 10:30 UTC.\n\n",
    );
    expect(p.source).toContain("\n\nYour code is 123456. It is valid for 10 minutes.");
    expect(p.source).not.toMatch(/<|&amp;/);
  });
});
