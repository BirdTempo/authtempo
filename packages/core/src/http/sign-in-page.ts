import { escapeHtml } from "./confirm-page.js";

export interface SignInPageInput {
  /** The path prefix of the auth routes, for the page's fetch calls and links. */
  basePath: string;
  /** The path the browser visits after any sign-in completes; carries the handoff id. */
  continuePath: string;
  /** Which methods the config enables. */
  methods: { magicLink: true; google: boolean; apple: boolean; passkey: boolean };
  /** The script nonce the policy header names. */
  nonce: string;
  /** The app name from the config. Escaped in the title and the heading. */
  appName: string;
}

/**
 * The page a native app opens in the system browser. Every method ends by
 * visiting `continuePath` on this origin, which mints the handoff code:
 * the magic link carries it as `next`, the social links carry it as
 * `next`, and the passkey script navigates to it after the verify. The
 * script runs under a nonce; the policy permits no other script.
 */
export function defaultSignInPage(input: SignInPageInput): string {
  const base = escapeHtml(input.basePath);
  const cont = escapeHtml(input.continuePath);
  const appName = escapeHtml(input.appName);
  const nextParam = encodeURIComponent(input.continuePath);
  const social = (name: string, label: string) =>
    `<a class="button" href="${base}/social/${name}/start?next=${escapeHtml(nextParam)}">${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>Sign in to ${appName}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); width: 22rem; max-width: 90vw; }
h1 { font-size: 1.25rem; margin: 0 0 1rem; }
[hidden] { display: none !important; }
.button, button { display: block; width: 100%; box-sizing: border-box; font: inherit; padding: 0.75rem 1rem; margin: 0.5rem 0; border: 0; border-radius: 0.375rem; background: #111; color: #fff; text-align: center; text-decoration: none; cursor: pointer; }
input { width: 100%; box-sizing: border-box; font: inherit; padding: 0.75rem; margin: 0.5rem 0; border: 1px solid #ccc; border-radius: 0.375rem; }
p.status { min-height: 1.5rem; color: #555; }
</style>
</head>
<body>
<main data-base="${base}" data-continue="${cont}">
<h1>Sign in to ${appName}</h1>
<form id="magic-link" method="post" autocomplete="on">
<input type="email" name="email" placeholder="you@example.com" required autofocus>
<button type="submit">Email me a sign-in link</button>
</form>
${input.methods.passkey ? `<button id="passkey" type="button">Sign in with a passkey</button>` : ""}
${input.methods.google ? social("google", "Continue with Google") : ""}
${input.methods.apple ? social("apple", "Continue with Apple") : ""}
<p class="status" id="status"></p>
</main>
<script nonce="${escapeHtml(input.nonce)}">
(function () {
  var main = document.querySelector("main");
  var base = main.getAttribute("data-base");
  var cont = main.getAttribute("data-continue");
  var status = document.getElementById("status");
  function say(text) { status.textContent = text; }
  function postJson(path, body) {
    return fetch(base + path, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  document.getElementById("magic-link").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = e.target.elements.email.value;
    postJson("/magic-link/request", { email: email, next: cont }).then(function (res) {
      if (res.ok) say("Check your email for a sign-in link.");
      else if (res.status === 429) say("Too many requests. Try again later.");
      else say("The request was not accepted.");
    }).catch(function () { say("Could not reach the server. Try again."); });
  });
  var passkey = document.getElementById("passkey");
  if (passkey && (typeof PublicKeyCredential === "undefined" || typeof PublicKeyCredential.parseRequestOptionsFromJSON !== "function")) passkey.hidden = true;
  if (passkey) passkey.addEventListener("click", function () {
    say("");
    postJson("/passkey/authenticate/options", {}).then(function (res) { return res.json(); }).then(function (options) {
      return navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
    }).then(function (cred) {
      return postJson("/passkey/authenticate/verify", { response: cred.toJSON() });
    }).then(function (res) {
      if (res.ok) { location.href = cont; } else { say("The passkey was not accepted."); }
    }).catch(function () { say("The passkey was not accepted."); });
  });
})();
</script>
</body>
</html>
`;
}
