import { escapeHtml } from "./confirm-page.js";

export interface HandoffConfirmPageInput {
  /** The path the form posts to. */
  action: string;
  handoffId: string;
  /** The signed-in account, shown so the person can see whose session continues. */
  email: string;
  /** Where the code goes: the app scheme, or the full dev redirect. */
  redirect: string;
  /** The app name from the config. Escaped in the title and the heading. */
  appName: string;
}

/**
 * The consent step of the handoff. A signed-in browser never hands a code
 * to an app on a plain navigation; the person presses the button. No
 * script, no framing. The form posts to this origin only.
 */
export function defaultHandoffConfirmPage(input: HandoffConfirmPageInput): string {
  const action = escapeHtml(input.action);
  const handoffId = escapeHtml(input.handoffId);
  const email = escapeHtml(input.email);
  const redirect = escapeHtml(input.redirect);
  const appName = escapeHtml(input.appName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>Continue to ${appName}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); text-align: center; max-width: 24rem; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>Continue to ${appName}?</h1>
<p>Signed in as <strong>${email}</strong>.</p>
<p>The app at <code>${redirect}</code> gets a one-time sign-in code.</p>
<p>Continue only if you started a sign-in in that app just now.</p>
<form method="post" action="${action}">
<input type="hidden" name="h" value="${handoffId}">
<button type="submit">Continue</button>
</form>
</main>
</body>
</html>
`;
}
