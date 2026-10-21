import { escapeHtml } from "./confirm-page.js";

export interface SsoContinuePageInput {
  /** The start path of the connection on this origin, with its `next` query. */
  location: string;
  /** The app name from the config. Escaped in the title and the heading. */
  appName: string;
}

/**
 * The answer of the SSO form of the sign-in page (plan 12d Task 4 fix M1).
 * Chromium applies `form-action` to each redirect that follows a form post.
 * After a 303 to the start, Chromium blocks the 302 to the IdP, because the
 * IdP origin is not in the policy. So the post ends on this page of this
 * origin. A meta refresh and a link go on to the start with a GET, and that
 * GET is not a form post. The page has no script and holds no secret.
 */
export function ssoContinuePage(input: SsoContinuePageInput): string {
  const location = escapeHtml(input.location);
  const appName = escapeHtml(input.appName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${location}">
<title>Continue to sign in to ${appName}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); text-align: center; max-width: 24rem; }
a { display: inline-block; padding: 0.75rem 1.5rem; border-radius: 0.375rem; background: #111; color: #fff; text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>Continue to sign in to ${appName}</h1>
<p>Your organization signs you in. If the next page does not open, press the button.</p>
<a href="${location}">Continue</a>
</main>
</body>
</html>
`;
}
