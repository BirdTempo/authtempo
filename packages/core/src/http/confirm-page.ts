export interface ConfirmPageInput {
  /** Path the form posts to, same origin as the page. */
  action: string;
  /** The clear magic link token. Already format-checked; escape it anyway. */
  token: string;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes the five characters that end or open HTML syntax. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/**
 * The page a magic link opens. It does nothing on load. The person presses
 * the button, and the browser posts the token to `action`. A mail scanner
 * that fetches the link gets this page and consumes nothing. No script, so
 * a scanner that runs JavaScript still consumes nothing.
 */
export function defaultConfirmPage(input: ConfirmPageInput): string {
  const action = escapeHtml(input.action);
  const token = escapeHtml(input.token);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Continue to sign in</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); text-align: center; max-width: 24rem; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>Continue to sign in</h1>
<p>Press the button to finish your sign-in.</p>
<form method="post" action="${action}">
<input type="hidden" name="token" value="${token}">
<button type="submit">Continue</button>
</form>
</main>
</body>
</html>
`;
}
