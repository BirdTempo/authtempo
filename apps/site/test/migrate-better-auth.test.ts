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

/**
 * The 1.7.7 caution of spec 23 item 12. The guide starts with it, before "Before you
 * start", and the phase "Cut over" starts with it again. This test holds the page copy,
 * as it holds the two breaks; check-migrate holds only the shape that all guides share.
 */
const CAUTION = [
  ":::caution",
  "Warning: upgrade Better Auth to 1.7.7 or later before the move. Version 1.7.7 fixed a magic link takeover, and the old system stays the rollback target during the move.",
  ":::",
] as const;

/** The lines from `from` to the next heading, with the blank lines removed. */
function partAfter(from: (line: string) => boolean): string[] {
  const lines = readFileSync(GUIDE, "utf8").split("\n");
  const start = lines.findIndex(from);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("#"));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l) => l.trim() !== "");
}

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
  it("starts with the 1.7.7 caution, before Before you start", () => {
    const intro = partAfter((l) => l.startsWith("**What it does:**"));
    expect(intro).toEqual([...CAUTION]);
  });

  it("starts the phase Cut over with the 1.7.7 caution", () => {
    const cutOver = partAfter((l) => l === "### Cut over");
    expect(cutOver.slice(0, 3)).toEqual([...CAUTION]);
  });

  it("states that getAccessToken callers break at the cutover", () => {
    expect(changeTheCalls()).toContain(BREAKS[0]);
  });

  it("states that cross-subdomain cookies break at the cutover", () => {
    expect(changeTheCalls()).toContain(BREAKS[1]);
  });
});
