import { escapeHtml } from "./confirm-page.js";

export interface PasswordVerifyPageInput {
  /** Path the form posts to, same origin as the page. */
  action: string;
  /** The clear `pv_` token. Already format-checked; escape it anyway. */
  token: string;
  appName: string;
}

export interface ResetPageInput {
  action: string;
  /** The clear `pr_` token. Already format-checked; escape it anyway. */
  token: string;
  appName: string;
  minLength: number;
  maxLength: number;
  /** Set when the last post was refused; the token is still valid then. */
  error: "password_policy" | "password_breached" | null;
}

const STYLE = `body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); text-align: center; max-width: 24rem; }
input { width: 100%; box-sizing: border-box; font: inherit; padding: 0.75rem; margin: 0.5rem 0; border: 1px solid #ccc; border-radius: 0.375rem; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; }
p.error { color: #a00; }`;

/** The caller passes a title that is already escaped. */
function page(title: string, body: string): string {
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
${body}
</main>
</body>
</html>
`;
}

/**
 * The page the sign-up mail opens. It does nothing on load, so a mail
 * scanner consumes nothing. The text tells the person to stop when they
 * did not sign up: pressing the button keeps the password of whoever did.
 */
export function defaultPasswordVerifyPage(input: PasswordVerifyPageInput): string {
  const appName = escapeHtml(input.appName);
  return page(
    `Confirm your email for ${appName}`,
    `<p>Press the button to confirm that you created an account on ${appName} with a password.</p>
<p>If you did not create an account, close this page.</p>
<form method="post" action="${escapeHtml(input.action)}">
<input type="hidden" name="token" value="${escapeHtml(input.token)}">
<button type="submit">Confirm</button>
</form>`,
  );
}

const POLICY = (i: ResetPageInput) =>
  `Use ${i.minLength} to ${i.maxLength} characters, no control characters, and not your email address.`;

const RESET_ERRORS = {
  password_policy: POLICY,
  password_breached: () => "This password is in a known data breach. Choose a different password.",
} as const;

/**
 * The page the reset mail opens. No script; the form posts the token and the
 * new password. The input has no `minlength` or `maxlength`: both count
 * UTF-16 code units, and the policy counts code points, so a browser would
 * refuse a valid password of 128 astral characters (256 units). The page's
 * policy permits no script, so the server's policy is the one check; the
 * page shows the rule before the first post (plan 8b).
 */
export function defaultResetPage(input: ResetPageInput): string {
  const error = input.error
    ? `<p class="error">${escapeHtml(RESET_ERRORS[input.error](input))}</p>\n`
    : "";
  // The rule once: a policy refusal already shows it as the error.
  const rule = input.error === "password_policy" ? "" : `<p>${escapeHtml(POLICY(input))}</p>\n`;
  return page(
    `Choose a new password for ${escapeHtml(input.appName)}`,
    `${error}${rule}<form method="post" action="${escapeHtml(input.action)}">
<input type="hidden" name="token" value="${escapeHtml(input.token)}">
<input type="password" name="password" autocomplete="new-password" required>
<button type="submit">Set password</button>
</form>`,
  );
}
