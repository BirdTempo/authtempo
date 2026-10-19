import { escapeHtml } from "./confirm-page.js";

/**
 * The line that the consent state of the device page shows (RFC 8628
 * section 5.4): a person who types a code that a stranger sent approves
 * the stranger's device.
 */
export const DEVICE_WARNING = "Approve only a device that is in front of you.";

/**
 * What the device page gets (plan 12e, RFC 8628 section 3.3). One page has
 * three states. `code`: the form for the user code. `consent`: the client of
 * a found code and its scopes, with the warning line. `done`: the decision
 * is stored, and the person goes back to the device.
 */
export type DevicePageInput =
  | {
      step: "code";
      /** Path the form posts to; same origin as the page. */
      action: string;
      appName: string;
      /** The signed-in user's address. */
      email: string;
      /** The code of `verification_uri_complete`, as `XXXX-XXXX`, or empty. The person still submits it (RFC 8628 section 3.3.1). */
      userCode: string;
      /** `invalid_code`: no live code matches. `unverified`: the user's address is not verified. */
      error: "invalid_code" | "unverified" | null;
    }
  | {
      step: "consent";
      action: string;
      appName: string;
      email: string;
      /** The client's own name, or its client id when it gave none. A claim of the client, not a fact. */
      clientName: string;
      clientId: string;
      /** The code that the person typed, as `XXXX-XXXX`: the person checks it against the device. */
      userCode: string;
      scopes: { name: string; description: string }[];
      /** The resource of the grant: the `aud` of the access tokens. */
      resource: string;
      /** The other configured resources: one consent covers each of them (plan 9g). */
      otherResources: string[];
      /** `DEVICE_WARNING`. */
      warning: string;
      /** The hidden fields the form posts back with `decision`: the user code. */
      fields: Record<string, string>;
    }
  | { step: "done"; appName: string; approved: boolean };

const STYLE = `body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); max-width: 26rem; }
ul { padding-left: 1.25rem; }
p.small { color: #555; font-size: 0.875rem; }
p.warn { font-weight: 600; }
p.error { color: #a00; }
input[type="text"] { font: inherit; font-size: 1.5rem; letter-spacing: 0.15em; padding: 0.5rem; width: 12rem; text-transform: uppercase; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; margin-right: 0.5rem; }
button[value="deny"] { background: #ddd; color: #111; }`;

const ERROR_TEXT = {
  invalid_code: "That code is not valid, or it has expired. Check the code on your device.",
  unverified: "Verify your email address before you connect a device.",
} as const;

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
${body}
</main>
</body>
</html>
`;
}

/**
 * The page of the device grant (plan 12e, RFC 8628). No script: each form
 * posts back to the page. `oauth.devicePage` replaces it; core sets the
 * headers.
 */
export function defaultDevicePage(input: DevicePageInput): string {
  const appName = escapeHtml(input.appName);
  if (input.step === "done") {
    const text = input.approved
      ? "The device is connected. Go back to your device."
      : "The device is not connected. You can close this page.";
    return page(`Device ${input.approved ? "connected" : "denied"}`, `<h1>${text}</h1>`);
  }
  if (input.step === "code") {
    const error =
      input.error === null ? "" : `<p class="error">${escapeHtml(ERROR_TEXT[input.error])}</p>\n`;
    return page(
      `Connect a device to ${appName}`,
      `<h1>Connect a device to ${appName}</h1>
<p>Type the code that your device shows.</p>
${error}<form method="post" action="${escapeHtml(input.action)}">
<input type="text" name="user_code" value="${escapeHtml(input.userCode)}" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
<button type="submit">Continue</button>
</form>
<p class="small">Signed in as ${escapeHtml(input.email)}.</p>`,
    );
  }
  const client = escapeHtml(input.clientName);
  const scopes = input.scopes
    .map((s) => `<li>${escapeHtml(s.description)} <code>${escapeHtml(s.name)}</code></li>`)
    .join("\n");
  const others =
    input.otherResources.length === 0
      ? ""
      : ` If you allow, it may also use these scopes at ${input.otherResources
          .map((r) => `<code>${escapeHtml(r)}</code>`)
          .join(", ")} with no new question.`;
  const fields = Object.entries(input.fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  return page(
    `Allow ${client} on a device to use your ${appName} account?`,
    `<h1>Allow ${client} on a device to use your ${appName} account?</h1>
<p class="warn">${escapeHtml(input.warning)}</p>
<p>Check that your device shows the code <code>${escapeHtml(input.userCode)}</code>.</p>
<p>It asks to:</p>
<ul>
${scopes}
</ul>
<p class="small">For <code>${escapeHtml(input.resource)}</code>.${others}</p>
<p class="small">Signed in as ${escapeHtml(input.email)}. Client id: <code>${escapeHtml(input.clientId)}</code>.</p>
<form method="post" action="${escapeHtml(input.action)}">
${fields}
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`,
  );
}
