/** The reserved names of RFC 2606 and RFC 6761. No party serves them. */
const RESERVED = /(^|\.)example\.(com|net|org)$|\.(example|invalid|localhost|test)$|^localhost$/;

/**
 * The hosts of other parties that core's own code names: the "vendors in the
 * path" of brand spec 9 (decision 2 of 2026-10-15). A host counts when an
 * https URL in a .ts file under packages/core/src/ names it, except:
 * - src/social/: the provider presets. An app turns each one on in its own
 *   config, and the sign-in goes to the provider that the app chose.
 * - src/testing/, src/storage/conformance.ts, and .test.ts files: test
 *   helpers that no deployment runs.
 * - the reserved names of RESERVED.
 */
export function vendorHosts(files: ReadonlyMap<string, string>): string[] {
  const hosts = new Set<string>();
  for (const [path, text] of files) {
    if (!path.includes("packages/core/src/") || !path.endsWith(".ts")) continue;
    if (
      path.includes("/src/social/") ||
      path.includes("/src/testing/") ||
      path.endsWith("/src/storage/conformance.ts") ||
      path.endsWith(".test.ts")
    )
      continue;
    for (const m of text.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
      const host = (m[1] ?? "").toLowerCase();
      if (!RESERVED.test(host)) hosts.add(host);
    }
  }
  return [...hosts].sort();
}
