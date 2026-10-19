import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const GUIDE = new URL("../src/content/docs/docs/migrate/better-auth.mdx", import.meta.url);

/**
 * The two breaks that the owner made mandatory in the Better Auth guide (the
 * Better Auth docs audit of 2026-10-14, summary items 7 and 8). Each names a
 * Better Auth feature that core declines. The page must hold this copy.
 */
const BREAKS = [
  "1. Core stores no provider access token (spec 9). So `getAccessToken` has no answer, and each caller of it breaks at the cutover. Move each call to the provider's own token flow before the move.",
  "2. The session cookie is `__Host-tempo_session` (plan 12b), and a browser never sends a `__Host-` cookie to a sibling subdomain. So `advanced.crossSubDomainCookies` has no map, and an app that shares its session across subdomains breaks at the cutover.",
] as const;

/** The lines of the phase "Change the calls", up to the next heading. */
function changeTheCalls(): string[] {
  const lines = readFileSync(GUIDE, "utf8").split("\n");
  const start = lines.indexOf("### Change the calls");
  if (start < 0) throw new Error("the guide has no phase ### Change the calls");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("#"));
  return end < 0 ? rest : rest.slice(0, end);
}

describe("the Better Auth guide", () => {
  it("states that getAccessToken callers break at the cutover", () => {
    expect(changeTheCalls()).toContain(BREAKS[0]);
  });

  it("states that cross-subdomain cookies break at the cutover", () => {
    expect(changeTheCalls()).toContain(BREAKS[1]);
  });
});
