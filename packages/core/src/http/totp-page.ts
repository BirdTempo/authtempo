import type { ChallengeMethod } from "../engine/second-factor.js";
import { escapeHtml } from "./confirm-page.js";

/** What the second-factor challenge page gets (plan 9f). */
export interface TotpChallengePageInput {
  /** Path the form posts to, and the page's own path; same origin as the page. */
  action: string;
  /** The clear `tf_` token. Already format-checked; escape it anyway. */
  challenge: string;
  appName: string;
  /** True when `method` is `backup`. Kept from plan 9f for a page of the app. */
  backup: boolean;
  /** The life of a trusted device, for the checkbox label. */
  trustDays: number;
  /** Set when the last post had a wrong code; the challenge still lives then. */
  error: "invalid_code" | null;
  /** The methods that pass for this challenge, in the order of preference (plan 12c). */
  methods: readonly ChallengeMethod[];
  /** The form this page shows (plan 12c). A passkey needs a script, so the page never shows it. */
  method: "totp" | "backup" | "email";
  /** True when a live trust cookie of the challenge's user came with the GET: the page shows one button that continues with no code (plan 12c). */
  trusted: boolean;
  /** True when the challenge holds an email code: the email form takes the code (plan 12c). */
  emailSent: boolean;
}

const STYLE = `body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); text-align: center; max-width: 24rem; }
input[type="text"] { width: 100%; box-sizing: border-box; font: inherit; padding: 0.75rem; margin: 0.5rem 0; border: 1px solid #ccc; border-radius: 0.375rem; }
label { display: block; margin: 0.5rem 0; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; }
p.error { color: #a00; }`;

/**
 * The page a gated sign-in or a gated reset sends the browser to (plans 9f
 * and 12c). No script: each form posts to `action`. The page shows one form
 * for `method`, a button for a trusted device, and a link for each other
 * method the challenge offers. `totp.challengePage` replaces it.
 */
export function defaultTotpPage(input: TotpChallengePageInput): string {
  const appName = escapeHtml(input.appName);
  const action = escapeHtml(input.action);
  const hidden = `<input type="hidden" name="challenge" value="${escapeHtml(input.challenge)}">`;
  const back = escapeHtml(`${input.action}?challenge=${encodeURIComponent(input.challenge)}`);
  const titles = {
    totp: `Enter the code for ${appName}`,
    backup: `Enter a backup code for ${appName}`,
    email: `Enter the code from your email for ${appName}`,
  };
  const title = titles[input.method];
  const error = input.error ? `<p class="error">The code is not correct. Try again.</p>\n` : "";
  const trustBox = `<label><input type="checkbox" name="trustDevice" value="1"> Trust this device for ${input.trustDays} days</label>`;
  const trusted = input.trusted
    ? `<form method="post" action="${action}">
${hidden}
<input type="hidden" name="action" value="trusted">
<button type="submit">Continue on this trusted device</button>
</form>
`
    : "";
  let body: string;
  if (input.method === "email" && !input.emailSent)
    body = `<p>We send a 6-digit code to the address of your account.</p>
<form method="post" action="${action}">
${hidden}
<input type="hidden" name="action" value="send-email">
<button type="submit">Send a code to my email</button>
</form>`;
  else {
    const field =
      input.method === "backup"
        ? `<input type="text" name="backupCode" autocomplete="off" autocapitalize="none" spellcheck="false" required>`
        : input.method === "email"
          ? `<input type="text" name="emailCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>`
          : `<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>`;
    const help = {
      totp: "Type the 6-digit code that your authenticator app shows.",
      backup: "Type one of the backup codes that you saved. Each code works once.",
      email: "Type the 6-digit code from the email. A new code replaces the old one.",
    }[input.method];
    const resend =
      input.method === "email"
        ? `
<form method="post" action="${action}">
${hidden}
<input type="hidden" name="action" value="send-email">
<button type="submit">Send a new code</button>
</form>`
        : "";
    body = `<p>${help}</p>
<form method="post" action="${action}">
${hidden}
${field}
${trustBox}
<button type="submit">Continue</button>
</form>${resend}`;
  }
  const links: string[] = [];
  if (input.method !== "totp" && input.methods.includes("totp"))
    links.push(`<p><a href="${back}">Use a code from your authenticator app</a></p>`);
  if (input.method !== "email" && input.methods.includes("email"))
    links.push(`<p><a href="${back}&amp;method=email">Use a code by email</a></p>`);
  if (input.method !== "backup" && input.methods.includes("backup"))
    links.push(`<p><a href="${back}&amp;backup=1">Use a backup code</a></p>`);
  if (input.methods.includes("passkey"))
    links.push("<p>A passkey works in the app's own sign-in page.</p>");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
${error}${trusted}${body}
${links.join("\n")}
</main>
</body>
</html>
`;
}
