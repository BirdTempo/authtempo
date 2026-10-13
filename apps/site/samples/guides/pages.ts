import {
  type ConfirmPageInput,
  createAuth,
  type MailPort,
  type StorageAdapter,
} from "@authtempo/core";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/**
 * The confirm page of a magic link. It must hold a form that posts `token` to
 * `action`. Core sets the headers: no script runs, and the form posts to this
 * origin only. Return the markup only.
 */
export function confirmPage(input: ConfirmPageInput): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in to ${escapeHtml(input.appName)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}</style></head>
<body>
<h1>Sign in to ${escapeHtml(input.appName)}</h1>
<form method="post" action="${escapeHtml(input.action)}">
<input type="hidden" name="token" value="${escapeHtml(input.token)}">
<button type="submit">Continue to ${escapeHtml(input.appName)}</button>
</form>
</body>
</html>`;
}

export function createPagesAuth(deps: { storage: StorageAdapter; mail: MailPort; secret: string }) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    appName: "Example",
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    magicLink: { confirmPage },
  });
}
