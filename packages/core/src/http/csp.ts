import type { ResolvedConfig } from "../config.js";

/**
 * The `form-action` sources a sign-in page may post to and, in Chromium,
 * redirect to after the post: this origin, the trusted web origins, and
 * the handoff schemes. A scheme source is `name:`.
 */
export function formAction(config: ResolvedConfig): string {
  const parts = ["'self'"];
  for (const o of config.trustedOrigins) {
    if (o.startsWith("https://") || o.startsWith("http://")) parts.push(o);
  }
  for (const s of config.handoff?.schemes ?? []) parts.push(s.replace(/:\/\/$/, ":"));
  return parts.join(" ");
}

/**
 * The policy of a page with no script: no remote resource, no framing. The
 * inline style is the page's own. `form-action` names this origin, the
 * trusted web origins, and the handoff schemes, because Chromium applies
 * it to every redirect that follows the form post.
 */
export function noScriptPagePolicy(config: ResolvedConfig): string {
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction(config)}; base-uri 'none'; frame-ancestors 'none'`;
}

/** The headers every page core serves carries. The policy differs per page. */
export function pageHeaders(_config: ResolvedConfig, policy: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // strict-origin, not no-referrer: with no-referrer Chrome sends Origin: null on a same-origin form post and the router refuses it (proved with headless Chrome 155 on 2026-10-09). strict-origin sends the origin only, so a token in the page URL never leaves in a Referer.
    "referrer-policy": "strict-origin",
    "x-robots-tag": "noindex",
    "content-security-policy": policy,
  };
}
