import { readFileSync } from "node:fs";
import {
  errorAnchor,
  ROUTER_CODES,
  ROUTES,
  type RouteEntry,
  type RouteKey,
} from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { DOCS } from "../scripts/lib/paths.ts";

// The operator pages of plan 12f Task 14 against the codes of the routes
// that their flows call. A code that a route declares and a page does not
// link fails here, so a new code of a route reaches its page.

/** The text of a `## ` section of a page, from its heading to the next one. */
function section(page: string, heading: string): string {
  const text = readFileSync(`${DOCS}docs/${page}`, "utf8");
  const start = text.indexOf(`\n## ${heading}\n`);
  expect({ page, heading, found: start >= 0 }).toEqual({ page, heading, found: true });
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The codes of the routes that `pick` takes, from `ROUTES`. */
function codesOf(pick: (route: RouteEntry) => boolean): Set<string> {
  const codes = new Set<string>();
  for (const r of ROUTES) if (pick(r)) for (const c of r.codes) codes.add(c);
  return codes;
}

/** The routes of the named keys. */
const keyed =
  (...keys: RouteKey[]) =>
  (r: RouteEntry) =>
    (keys as string[]).includes(`${r.method} ${r.path}`);

/** Each code has a link to its anchor in the section, and the check names a code that lacks one. */
function expectLinks(text: string, codes: Iterable<string>) {
  for (const code of codes) {
    const href = `/docs/reference/errors/#${errorAnchor(code, "core")}`;
    expect({ code, linked: text.includes(`](${href})`) }).toEqual({ code, linked: true });
  }
}

/** A router code that a page names when its flow can meet it. `internal` is no answer of a flow. */
const ROUTER = ROUTER_CODES.filter((c) => c !== "internal");

describe("the operator pages", () => {
  it("links each code of the operator routes in the guide", () => {
    const codes = codesOf(
      (r) => r.feature === "operatorUsers" || r.feature === "operatorImpersonation",
    );
    // The routes of the two features exist, so the set is never empty.
    expect(codes.size).toBeGreaterThan(10);
    expectLinks(section("guides/operator-tools.mdx", "If it fails"), [...codes, ...ROUTER]);
  });

  it("links each code of create-admin and users get in the first operator runbook", () => {
    const codes = codesOf(keyed("POST /operator/users/create-admin", "GET /operator/users/get"));
    expectLinks(section("operations/first-operator.mdx", "If it fails"), [...codes, "not_found"]);
  });

  it("links each code of the ban flow in the ban runbook", () => {
    const codes = codesOf(
      keyed(
        "GET /operator/users/search",
        "POST /operator/users/ban",
        "GET /operator/users/get",
        "GET /operator/audit",
      ),
    );
    expectLinks(section("operations/ban-a-user.mdx", "If it fails"), [...codes, "not_found"]);
  });

  it("links each code of the factor disable in the dated note of the recovery runbook", () => {
    const codes = codesOf(keyed("POST /operator/users/second-factor/disable"));
    expectLinks(section("operations/second-factor-recovery.mdx", "Update 2026-10-21 by plan 12f"), [
      ...codes,
      "not_found",
    ]);
  });
});
