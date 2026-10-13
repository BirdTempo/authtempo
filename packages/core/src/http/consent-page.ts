import { escapeHtml } from "./confirm-page.js";

/** What the OAuth consent page gets (plan 9g). */
export interface ConsentPageInput {
  /** Path the form posts to, and the page's own path; same origin as the page. */
  action: string;
  appName: string;
  /** The client's own name, or its client id when it gave none. A claim of the client, not a fact. */
  clientName: string;
  clientId: string;
  /** Where the browser goes after the answer: the redirect URI's origin, or its scheme. */
  redirectTo: string;
  /** The signed-in user's address. */
  email: string;
  scopes: { name: string; description: string }[];
  /** The authorization request, posted back as hidden fields. */
  fields: Record<string, string>;
}

const STYLE = `body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); max-width: 26rem; }
ul { padding-left: 1.25rem; }
p.small { color: #555; font-size: 0.875rem; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; margin-right: 0.5rem; }
button[value="deny"] { background: #ddd; color: #111; }`;

/**
 * The page that asks a person to let an OAuth client act for them (plan
 * 9g). No script: the form posts the request back with `decision=allow` or
 * `decision=deny`. `oauth.consentPage` replaces it; core sets the headers.
 */
export function defaultConsentPage(input: ConsentPageInput): string {
  const client = escapeHtml(input.clientName);
  const appName = escapeHtml(input.appName);
  const scopes = input.scopes
    .map((s) => `<li>${escapeHtml(s.description)} <code>${escapeHtml(s.name)}</code></li>`)
    .join("\n");
  const fields = Object.entries(input.fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>Allow ${client} to use your ${appName} account?</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
<h1>Allow ${client} to use your ${appName} account?</h1>
<p>It asks to:</p>
<ul>
${scopes}
</ul>
<p class="small">Signed in as ${escapeHtml(input.email)}. Client id: <code>${escapeHtml(input.clientId)}</code>.</p>
<p class="small">After your answer, the browser goes to ${escapeHtml(input.redirectTo)}.</p>
<form method="post" action="${escapeHtml(input.action)}">
${fields}
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</main>
</body>
</html>
`;
}
