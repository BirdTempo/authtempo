import type { ResolvedConfig } from "../config.js";
import { redirectAllowed } from "../engine/handoff.js";

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

/**
 * The source that lets `form-action` follow a dev redirect: the origin of a
 * loopback http(s) URL, or the scheme of any other URL (`exp:`). It is null
 * when the URL does not parse, and for an IPv6 host, because a CSP
 * host-source has no IPv6 literal form. Use 127.0.0.1 in that case.
 */
function devRedirectSource(redirect: string): string | null {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return url.hostname.startsWith("[") ? null : url.origin;
  }
  return url.protocol;
}

/**
 * The policy of the handoff confirm page. It is the no-script policy plus
 * the source of the handoff redirect. A redirect that `devRedirectPattern`
 * admitted is in no other list, and without its source Chromium refuses the
 * 302 that answers the Continue post. The match is the one the handoff
 * start uses, so the page never lists a source the start refused.
 */
export function confirmPagePolicy(config: ResolvedConfig, redirect: string): string {
  const parts = formAction(config).split(" ");
  const source = redirectAllowed(config, redirect) ? devRedirectSource(redirect) : null;
  if (source !== null && !parts.includes(source)) parts.push(source);
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${parts.join(" ")}; base-uri 'none'; frame-ancestors 'none'`;
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
