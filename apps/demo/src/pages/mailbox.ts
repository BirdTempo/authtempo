import { type Html, html } from "../html.js";
import type { DemoMail } from "../mail.js";
import type { PageBody, PageState } from "./layout.js";

/** A URL in a mail text. The end stops before a space, a quote, or an angle bracket. */
const URL_RE = /https?:\/\/[^\s<>"']+/g;
/** A code of core's mails: 6 to 8 digits. */
const CODE_RE = /\b\d{6,8}\b/g;

/** One line of plain text with each code in a code element. */
function codes(text: string): Html[] {
  const out: Html[] = [];
  let at = 0;
  for (const m of text.matchAll(CODE_RE)) {
    out.push(html`${text.slice(at, m.index)}<code>${m[0]}</code>`);
    at = m.index + m[0].length;
  }
  out.push(html`${text.slice(at)}`);
  return out;
}

/**
 * One line of a mail. A URL of the demo origin is a link. Any other URL
 * stays text. A mail can hold a name that a visitor typed. The page must
 * not make a link to another site from that name.
 */
function line(text: string, origin: string): Html[] {
  const out: Html[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,)]+$/, "");
    let own = false;
    try {
      own = new URL(raw).origin === origin;
    } catch {
      own = false;
    }
    if (!own) continue;
    out.push(...codes(text.slice(at, m.index)));
    out.push(html`<a href="${raw}">${raw}</a>`);
    at = m.index + raw.length;
  }
  out.push(...codes(text.slice(at)));
  return out;
}

function mailHtml(m: DemoMail, origin: string): Html {
  const at = new Date(m.at).toISOString();
  const paragraphs = m.text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => html`<p>${line(p.replace(/\n/g, " "), origin)}</p>`);
  return html`<article class="mail"><h2>${m.subject}</h2><p class="meta">To ${m.to}, at <time datetime="${at}">${at.slice(11, 19)} UTC</time></p>${paragraphs}</article>`;
}

export const mailboxPage: PageBody = {
  script: null,
  body: (
    s: PageState,
  ) => html`<p class="lede">The mails of your sandbox, newest first. Only your sandbox can read them.</p>
<p><a href="/mailbox">Read the mailbox again</a></p>
${s.mail.length === 0 ? html`<p class="empty">The mailbox is empty. Ask for a link or a code on a method page.</p>` : s.mail.map((m) => mailHtml(m, s.origin))}`,
};
