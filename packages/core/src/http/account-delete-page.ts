import { escapeHtml } from "./confirm-page.js";

export interface AccountDeletePageInput {
  /** Path the form posts to, same origin as the page. */
  action: string;
  /** The clear `ad_` token. Already format-checked; escape it anyway. */
  token: string;
  /** The app name from the config. Escaped in the title and the heading. */
  appName: string;
}

/**
 * The page a delete link opens (plan 12a Task 20). It does nothing on load:
 * the person presses the button, and the browser posts the token with the
 * session cookie. A mail scanner that fetches the link gets this page and
 * deletes nothing. No script, so a scanner that runs JavaScript deletes
 * nothing either.
 */
export function defaultAccountDeletePage(input: AccountDeletePageInput): string {
  const action = escapeHtml(input.action);
  const token = escapeHtml(input.token);
  const appName = escapeHtml(input.appName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>Delete your ${appName} account</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); text-align: center; max-width: 24rem; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #b00020; color: #fff; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>Delete your ${appName} account</h1>
<p>Press the button to delete your account. The delete cannot be undone. You must be signed in on this device.</p>
<form method="post" action="${action}">
<input type="hidden" name="token" value="${token}">
<button type="submit">Delete my account</button>
</form>
</main>
</body>
</html>
`;
}
