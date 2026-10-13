import { escapeHtml } from "./confirm-page.js";

/** What the second-factor challenge page gets (plan 9f). */
export interface TotpChallengePageInput {
  /** Path the form posts to, and the page's own path; same origin as the page. */
  action: string;
  /** The clear `tf_` token. Already format-checked; escape it anyway. */
  challenge: string;
  appName: string;
  /** True: the form takes a backup code in place of the 6-digit code. */
  backup: boolean;
  /** The life of a trusted device, for the checkbox label. */
  trustDays: number;
  /** Set when the last post had a wrong code; the challenge still lives then. */
  error: "invalid_code" | null;
}

const STYLE = `body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); text-align: center; max-width: 24rem; }
input[type="text"] { width: 100%; box-sizing: border-box; font: inherit; padding: 0.75rem; margin: 0.5rem 0; border: 1px solid #ccc; border-radius: 0.375rem; }
label { display: block; margin: 0.5rem 0; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; }
p.error { color: #a00; }`;

/**
 * The page a password sign-in sends the browser to when the user has a
 * second factor (plan 9f). No script: the form posts the challenge and the
 * code to `action`. The link switches between the app's code and a backup
 * code. `totp.challengePage` replaces it.
 */
export function defaultTotpPage(input: TotpChallengePageInput): string {
  const appName = escapeHtml(input.appName);
  const action = escapeHtml(input.action);
  const back = escapeHtml(`${input.action}?challenge=${encodeURIComponent(input.challenge)}`);
  const title = input.backup
    ? `Enter a backup code for ${appName}`
    : `Enter the code for ${appName}`;
  const error = input.error ? `<p class="error">The code is not correct. Try again.</p>\n` : "";
  const help = input.backup
    ? "Type one of the backup codes that you saved. Each code works once."
    : "Type the 6-digit code that your authenticator app shows.";
  const field = input.backup
    ? `<input type="text" name="backupCode" autocomplete="off" autocapitalize="none" spellcheck="false" required>`
    : `<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>`;
  const other = input.backup
    ? `<p><a href="${back}">Use a code from your authenticator app</a></p>`
    : `<p><a href="${back}&amp;backup=1">Use a backup code</a></p>`;
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
${error}<p>${help}</p>
<form method="post" action="${action}">
<input type="hidden" name="challenge" value="${escapeHtml(input.challenge)}">
${field}
<label><input type="checkbox" name="trustDevice" value="1"> Trust this device for ${input.trustDays} days</label>
<button type="submit">Continue</button>
</form>
${other}
</main>
</body>
</html>
`;
}
