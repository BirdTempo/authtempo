import { escapeHtml } from "./confirm-page.js";

/**
 * The input of the end-session page (plan 12e). `confirm` asks the person
 * before a session ends: no valid hint of this session came (RP-Initiated
 * Logout 1.0 section 2). `signed-out` tells the person that no session of
 * this browser is left.
 */
export type EndSessionPageInput =
  | {
      kind: "confirm";
      /** The path the form posts to, on this origin. */
      action: string;
      /** The app name from the config. Escaped in the title and the heading. */
      appName: string;
      /** The request of the relying party, posted back with the yes, so the same checks run again. */
      fields: Readonly<Record<string, string>>;
    }
  | { kind: "signed-out"; appName: string }
  /**
   * A request in a frame, which carries no SameSite=Lax cookie. The page
   * says nothing of the session and links to the same GET at the top.
   */
  | { kind: "framed"; appName: string; href: string };

const STYLE = `<style>
body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); text-align: center; max-width: 24rem; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; }
</style>`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>${title}</title>
${STYLE}
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/**
 * The end-session page. No script and no framing. The confirm form posts
 * `confirm=yes` to this origin only. A page load ends nothing; the person
 * presses the button.
 */
export function defaultEndSessionPage(input: EndSessionPageInput): string {
  const appName = escapeHtml(input.appName);
  if (input.kind === "framed")
    return shell(
      `Sign out of ${appName}`,
      `<h1>Sign out of ${appName}</h1>
<p>A sign-out cannot run inside a frame.</p>
<p><a href="${escapeHtml(input.href)}" target="_top">Continue to sign out</a></p>`,
    );
  if (input.kind === "signed-out")
    return shell(
      `Signed out of ${appName}`,
      `<h1>You are signed out</h1>
<p>You can close this page.</p>`,
    );
  const hidden = Object.entries(input.fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("\n");
  return shell(
    `Sign out of ${appName}?`,
    `<h1>Sign out of ${appName}?</h1>
<p>An app asks to end your session. Sign out only if you asked for it.</p>
<form method="post" action="${escapeHtml(input.action)}">
${hidden}
<input type="hidden" name="confirm" value="yes">
<button type="submit">Sign out</button>
</form>`,
  );
}
