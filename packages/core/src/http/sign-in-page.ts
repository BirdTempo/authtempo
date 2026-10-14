import { escapeHtml } from "./confirm-page.js";

export interface SignInPageInput {
  /** The path prefix of the auth routes, for the page's fetch calls and links. */
  basePath: string;
  /** The path the browser visits after any sign-in completes; carries the handoff id. */
  continuePath: string;
  /**
   * Which methods the config enables. `password` is true when the config
   * has a `password` section: the page shows the password form and the
   * forgot button. `magicLink` is false only when a caller serves no magic
   * link route (the Better Auth compatibility package without its magicLink
   * plugin, plan 9). Core passes true.
   */
  methods: {
    magicLink: boolean;
    google: boolean;
    apple: boolean;
    passkey: boolean;
    password: boolean;
    /**
     * Every configured provider other than Google and Apple, in config order
     * (plan 9c): GitHub, LinkedIn, and each list entry. The page escapes the
     * label and encodes the name.
     */
    providers: Array<{ name: string; label: string }>;
  };
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
    `<a class="button" href="${base}/social/${escapeHtml(encodeURIComponent(name))}/start?next=${escapeHtml(nextParam)}">${escapeHtml(label)}</a>`;
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
${
  input.methods.magicLink
    ? `<form id="magic-link" method="post" autocomplete="on">
<input type="email" name="email" placeholder="you@example.com" required autofocus>
<button type="submit">Email me a sign-in link</button>
</form>`
    : ""
}
${
  input.methods.password
    ? `<form id="password" method="post" action="${base}/password/sign-in" autocomplete="on">
<input type="email" name="email" placeholder="you@example.com" autocomplete="username" required>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
<button type="submit">Sign in with password</button>
<button id="sign-up" type="button">Create account</button>
<button id="forgot" type="button">Forgot password</button>
</form>`
    : ""
}
${input.methods.passkey ? `<button id="passkey" type="button">Sign in with a passkey</button>` : ""}
${input.methods.google ? social("google", "Continue with Google") : ""}
${input.methods.apple ? social("apple", "Continue with Apple") : ""}
${input.methods.providers.map((p) => social(p.name, p.label)).join("\n")}
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
  var ml = document.getElementById("magic-link");
  if (ml) ml.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = e.target.elements.email.value;
    postJson("/magic-link/request", { email: email, next: cont }).then(function (res) {
      if (res.ok) say("Check your email for a sign-in link.");
      else if (res.status === 429) say("Too many requests. Try again later.");
      else say("The request was not accepted.");
    }).catch(function () { say("Could not reach the server. Try again."); });
  });
  var pwForm = document.getElementById("password");
  if (pwForm) {
    pwForm.addEventListener("submit", function (e) {
      e.preventDefault();
      say("");
      postJson("/password/sign-in", { email: pwForm.elements.email.value, password: pwForm.elements.password.value, next: cont }).then(function (res) {
        // A user with a second factor gets a challenge and no cookie yet (plan 9f): the challenge page lands on cont.
        if (res.ok) return res.json().then(function (body) {
          if (body && body.twoFactor) location.href = base + "/totp/challenge?challenge=" + encodeURIComponent(body.twoFactor.challenge);
          else location.href = cont;
        });
        else if (res.status === 401) say("The email or the password is not correct.");
        else if (res.status === 429) say("Too many attempts. Try again later.");
        // password.requireVerified (plan 12b): the right password of an unverified address.
        else if (res.status === 403) return res.json().then(function (body) {
          say(body && body.error === "email_unverified" ? "Confirm your email address first. We sent you a new link." : "The request was not accepted.");
        }, function () { say("The request was not accepted."); });
        else say("The request was not accepted.");
      }).catch(function () { say("Could not reach the server. Try again."); });
    });
    document.getElementById("forgot").addEventListener("click", function () {
      var email = pwForm.elements.email.value;
      if (!email) { say("Type your email first."); return; }
      postJson("/password/reset/request", { email: email, next: cont }).then(function (res) {
        if (res.ok) say("Check your email for a link to reset your password.");
        else if (res.status === 429) say("Too many requests. Try again later.");
        else say("The request was not accepted.");
      }).catch(function () { say("Could not reach the server. Try again."); });
    });
    // Plan 10: sign-up on the page. The sign-up answer sets the session cookie, so success
    // goes to the continue path as the sign-in does. With password.requireVerified on, it sets
    // no cookie, and the page asks for the mailed link. The codes come from core's ERRORS table.
    // With the uniform answer (plan 12b) the page asks the person to read the mail, and enables the buttons again.
    // reportValidity runs the type=email check and the required attributes, as the
    // submit button does, so an empty field never posts. The button stays disabled
    // while the request runs so that a second click does not post twice. The form's
    // submit button is disabled too, so a Sign in click or the Enter key cannot post
    // a sign-in during the sign-up. Every failure path enables both again. Success
    // navigates away, so they stay disabled.
    var signUp = document.getElementById("sign-up");
    var signInButton = pwForm.querySelector('button[type="submit"]');
    signUp.addEventListener("click", function () {
      if (!pwForm.reportValidity()) return;
      function fail(text) { signUp.disabled = false; signInButton.disabled = false; say(text); }
      signUp.disabled = true;
      signInButton.disabled = true;
      say("");
      postJson("/password/sign-up", { email: pwForm.elements.email.value, password: pwForm.elements.password.value }).then(function (res) {
        // password.requireVerified (plan 12b): the sign-up opens no session, and the mailed link signs in.
        if (res.ok) return res.json().then(function (body) {
          if (body && body.sent) fail("Check your email to continue.");
          else if (body && body.verifyRequired) fail("Check your email for a link to confirm your address.");
          else location.href = cont;
        }, function () { location.href = cont; });
        if (res.status === 429) { fail("Too many attempts. Try again later."); return; }
        return res.json().then(function (body) {
          var code = body && body.error;
          if (code === "email_taken" || code === "email_taken_unverified") fail("An account with this address exists. Sign in instead.");
          else if (code === "password_policy") fail("The password is too short, too long, has a control character, or equals your email address.");
          else if (code === "password_breached") fail("This password is in a known data breach. Choose another one.");
          else fail("The request was not accepted.");
        }, function () { fail("The request was not accepted."); });
      }).catch(function () { fail("Could not reach the server. Try again."); });
    });
  }
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
