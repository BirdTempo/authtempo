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

/** The headers every page core serves carries. The policy differs per page. */
export function pageHeaders(_config: ResolvedConfig, policy: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
    "content-security-policy": policy,
  };
}
