import { readFileSync } from "node:fs";
import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { DOCS } from "../scripts/lib/paths.ts";

/** The error codes that the "If it fails" section of a guide links, sorted. */
function linkedCodes(page: string): string[] {
  const text = readFileSync(`${DOCS}docs/guides/${page}`, "utf8");
  const lines = text.split("\n");
  const at = lines.indexOf("## If it fails");
  const end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  if (at < 0) throw new Error(`${page} has no "If it fails" section`);
  const section = lines.slice(at + 1, end < 0 ? undefined : end).join("\n");
  const codes = [...section.matchAll(/\/docs\/reference\/errors\/#([a-z_]+)\)/g)].map((m) => m[1]);
  return [...new Set(codes as string[])].sort();
}

/** The codes that ROUTES lists for the routes of some features, sorted. */
function routeCodes(features: readonly string[]): string[] {
  const codes = ROUTES.filter((r) => features.includes(r.feature)).flatMap((r) => r.codes);
  return [...new Set<string>(codes)].sort();
}

// Review m1 of plan 12d Task 13: a guide links each code that its routes answer.
// A guide may link more, such as sso_required of the other sign-in routes.
describe("the If it fails section of the SSO and SCIM guides", () => {
  // The SSO guide also tells of the operator's override, POST /operator/sso/enforce-off.
  it.each([
    ["sso.mdx", ["sso", "operatorSso"]],
    ["scim.mdx", ["scim"]],
  ] as const)("%s links every code of the routes of %j", (page, features) => {
    const codes = routeCodes(features);
    expect(codes.length).toBeGreaterThan(0);
    const missing = codes.filter((c) => !linkedCodes(page).includes(c));
    expect(missing).toEqual([]);
  });
});
