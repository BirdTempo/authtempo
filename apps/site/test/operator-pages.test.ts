import { readFileSync } from "node:fs";
import {
  errorAnchor,
  ROUTER_CODES,
  ROUTES,
  type RouteEntry,
  type RouteKey,
  USER_ACTOR_CODES,
} from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { DOCS } from "../scripts/lib/paths.ts";

// The operator pages of plan 12f Task 14 against the codes of the routes
// that their flows call. Each check holds the linked codes of a section
// equal to the codes of its flow, both ways. A code that a route declares
// and a page does not link fails. A link to a code that the flow cannot
// answer fails too.

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

/** The codes that a section links on the errors page, from each `](/docs/reference/errors/#<code>)`. */
function linkedCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const m of text.matchAll(/\]\(\/docs\/reference\/errors\/#([a-z0-9_-]+)\)/g))
    if (m[1] !== undefined) codes.add(m[1]);
  return [...codes].sort();
}

/**
 * The section links each code of `codes` and no other code. The check names
 * the codes that lack a link and the links of codes outside the flow.
 */
function expectLinks(page: string, text: string, codes: Iterable<string>) {
  const want = [...new Set([...codes].map((c) => errorAnchor(c, "core")))].sort();
  const got = linkedCodes(text);
  expect({
    page,
    missing: want.filter((c) => !got.includes(c)),
    extra: got.filter((c) => !want.includes(c)),
  }).toEqual({ page, missing: [], extra: [] });
}

/**
 * The codes of the routes that `pick` takes, as a call with an operator
 * secret meets them. The codes that only a request with a session gets
 * are out. Each runbook is a run of the CLI, which sends a secret only.
 */
function secretCodesOf(pick: (route: RouteEntry) => boolean): Set<string> {
  const session: readonly string[] = USER_ACTOR_CODES;
  return new Set([...codesOf(pick)].filter((c) => !session.includes(c)));
}

/**
 * The words of the guide's refused list for each route that answers
 * `impersonation_session` (the routes of `IMPERSONATION_REFUSED`, which a
 * core test holds to `ROUTES`). A refused route with no rule fails, a rule
 * with no refused route fails, and words that the list lacks fail.
 */
const REFUSED_WORDS: readonly (readonly [RegExp, string])[] = [
  [/^\/operator\/(?!impersonate\/stop$)/, "each operator route but the stop"],
  [/^\/sign-out$/, "the sign-out"],
  [/^\/reauth(\/|$)/, "the re-authentication"],
  [/^\/password\/change$/, "the password"],
  [/^\/passkey\/register\/|^\/passkeys\/delete$/, "a passkey"],
  [/^\/user\/change-email(\/verify)?$/, "the address"],
  [/^\/identities\/unlink$/, "an unlink"],
  [/^\/social\/:provider\/link$/, "a social link"],
  [/^\/tokens$/, "a new API token"],
  [/^\/user\/delete(\/confirm)?$/, "the account delete"],
  [/^\/totp(\/|$)|^\/second-factor\//, "each second-factor route"],
  [/^\/handoff\/start$/, "the handoff start"],
  [/^\/handoff\/continue$/, "the handoff continue"],
  [/^\/oauth\/authorize$/, "the OAuth authorize"],
  [/^\/oauth\/sign-in$/, "sign-in"],
  [/^\/oauth\/device$/, "device approval"],
  [/^\/oauth\/grants\/revoke$/, "grant revoke"],
  [/^\/oauth\/end-session$/, "end-session routes"],
  [/^\/organizations\/delete$/, "the organization delete"],
  [/^\/organizations\/members\/add$/, "the add"],
  [/^\/organizations\/members\/role$/, "the role change"],
  [/^\/organizations\/members\/remove$/, "the removal"],
  [/^\/organizations\/invite$/, "the invitation of a member"],
  // Plan 12k (ruling 5 of plan 12k): the role writes and the token writes.
  [/^\/organizations\/roles\/(create|update|delete)$/, "the role writes of dynamic roles"],
  [/^\/tokens\/update$|^\/organizations\/tokens(\/update|\/revoke)?$/, "the token writes"],
  // Plan 12d Task 2b: the four domain writes.
  [/^\/sso\/domains\/(add|verify|update|delete)$/, "the domain writes of SSO"],
  // Plan 12d Task 3: the three connection writes.
  [/^\/sso\/connections\/(create|update|delete)$/, "the connection writes of SSO"],
];

/** A router code that a page names when its flow can meet it. `internal` is no answer of a flow. */
const ROUTER = ROUTER_CODES.filter((c) => c !== "internal");

describe("the operator pages", () => {
  it("links each code of the operator routes in the guide", () => {
    const codes = codesOf(
      (r) => r.feature === "operatorUsers" || r.feature === "operatorImpersonation",
    );
    // The routes of the two features exist, so the set is never empty.
    expect(codes.size).toBeGreaterThan(10);
    const page = "guides/operator-tools.mdx";
    expectLinks(page, section(page, "If it fails"), [...codes, ...ROUTER]);
  });

  it("names each refused route of an impersonation session in the guide", () => {
    const page = "guides/operator-tools.mdx";
    const text = section(page, "The impersonation");
    const list = text.slice(text.indexOf("An impersonation session can never reach"));
    const listed: readonly RouteEntry[] = ROUTES;
    const refused = listed.filter((r) => r.codes.includes("impersonation_session"));
    // IMPERSONATION_REFUSED holds 61 routes at plan 12f Task 14, so the list is never empty.
    expect(refused.length).toBeGreaterThan(50);
    const used = new Set<number>();
    for (const r of refused) {
      const at = REFUSED_WORDS.findIndex(([path]) => path.test(r.path));
      expect({ route: `${r.method} ${r.path}`, rule: at >= 0 }).toEqual({
        route: `${r.method} ${r.path}`,
        rule: true,
      });
      used.add(at);
    }
    for (const [i, [path, words]] of REFUSED_WORDS.entries())
      expect({ words, used: used.has(i), named: list.includes(words) }, String(path)).toEqual({
        words,
        used: true,
        named: true,
      });
  });

  it("links each code of create-admin and users get in the first operator runbook", () => {
    const codes = secretCodesOf(
      keyed("POST /operator/users/create-admin", "GET /operator/users/get"),
    );
    const page = "operations/first-operator.mdx";
    expectLinks(page, section(page, "If it fails"), [...codes, "not_found"]);
  });

  it("links each code of the ban flow in the ban runbook", () => {
    const codes = secretCodesOf(
      keyed(
        "GET /operator/users/search",
        "POST /operator/users/ban",
        "GET /operator/users/get",
        "GET /operator/audit",
        "POST /operator/sessions/end-user",
      ),
    );
    const page = "operations/ban-a-user.mdx";
    expectLinks(page, section(page, "If it fails"), [...codes, "not_found"]);
  });

  it("links each code of the factor disable in the dated note of the recovery runbook", () => {
    const codes = secretCodesOf(
      keyed("GET /operator/users/search", "POST /operator/users/second-factor/disable"),
    );
    const page = "operations/second-factor-recovery.mdx";
    expectLinks(page, section(page, "Update 2026-10-21 by plan 12f"), [...codes, "not_found"]);
  });
});
