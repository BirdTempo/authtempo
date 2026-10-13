import type { ResolvedConfig } from "../config.js";
import { randomBase64Url } from "../primitives/crypto.js";
import { formAction, pageHeaders } from "./csp.js";
import { defaultSignInPage } from "./sign-in-page.js";

/**
 * The sign-in page with its script nonce and policy (plan 5a; one copy for
 * the handoff and the OAuth login step since plan 9g). Every method lands
 * on `continuePath`. `handoff.signInPage` replaces the page for both.
 */
export function signInPageResponse(config: ResolvedConfig, continuePath: string): Response {
  const methods = {
    magicLink: true as const,
    google: config.social.providers.some((p) => p.name === "google"),
    apple: config.social.providers.some((p) => p.name === "apple"),
    passkey: config.passkey !== null,
    password: config.password !== null,
    // Plan 9c: GitHub, LinkedIn, and each list entry, with the label the config gives.
    providers: config.social.providers
      .filter((p) => p.name !== "google" && p.name !== "apple")
      .map((p) => ({ name: p.name, label: p.label })),
  };
  const nonce = randomBase64Url(16);
  const render = config.handoff?.signInPage ?? defaultSignInPage;
  const html = render({
    basePath: config.basePath,
    continuePath,
    methods,
    nonce,
    appName: config.appName,
  });
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action ${formAction(config)}; base-uri 'none'; frame-ancestors 'none'`;
  return new Response(html, { status: 200, headers: pageHeaders(config, policy) });
}
