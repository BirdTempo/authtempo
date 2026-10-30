import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The SSO and SCIM limits of plan 12d (m1 of the final review, ruling 74).
// The limits page, the routes page, and the SCIM guide state numbers that
// the engine holds as constants. This test reads each constant from the
// source and each number from the pages. A number changed on one side only
// fails here, as limit-rows.test.ts does for the limits of plan 12a.

const CORE = `${REPO}packages/core/src/`;
const source = (file: string) => readFileSync(`${CORE}${file}`, "utf8");
const page = (file: string) => readFileSync(`${DOCS}docs/${file}`, "utf8");

/** The value of a numeric text of the source: digits with `_`, and products such as `15 * 60`. */
function numberOf(text: string): number {
  return text
    .split("*")
    .map((part) => Number(part.trim().replaceAll("_", "")))
    .reduce((a, b) => a * b, 1);
}

/** The value of `const NAME = <number>;` in `file`. */
function constant(file: string, name: string): number {
  const m = new RegExp(`const ${name} = ([0-9_ *]+);`).exec(source(file));
  if (!m) throw new Error(`no constant ${name} in ${file}`);
  return numberOf(m[1] ?? "");
}

/** The SSO and SCIM files that call the limiter. */
const LIMITED = [
  "engine/sso/discover.ts",
  "engine/sso/oidc.ts",
  "engine/sso/saml-sp.ts",
  "engine/sso/domains.ts",
  "engine/scim/tokens.ts",
  "http/routes/sso.ts",
];

type Limit = { seconds: number; max: number };

/** Each limiter key of the SSO and SCIM files, by its `name:scope` prefix, with its constant. */
function engineLimits(): Map<string, Limit> {
  const keys = new Map<string, Limit>();
  for (const file of LIMITED) {
    const src = source(file);
    const constants = new Map<string, Limit>();
    for (const m of src.matchAll(/const ([A-Z_]+) = \{ seconds: ([0-9_ *]+), max: ([0-9_]+) \};/g))
      constants.set(m[1] ?? "", { seconds: numberOf(m[2] ?? ""), max: numberOf(m[3] ?? "") });
    // Since plan 12h each site calls limit(config, "<family>", <subject>, <window>).
    for (const m of src.matchAll(
      /(?<![\w.])limit\(\s*[\w.]+,\s*"([a-z-]+:[a-z]+)",\s*[^,]+,\s*([A-Z_]+)\s*,?\s*\)/g,
    )) {
      const limit = constants.get(m[2] ?? "");
      if (!limit) throw new Error(`no constant ${m[2]} in ${file}`);
      keys.set(m[1] ?? "", limit);
    }
  }
  return keys;
}

const UNIT: Readonly<Record<string, number>> = { minute: 60, hour: 3600, day: 86_400 };

/** The rows `| \`name:scope:<...>\` | N unit | max |` of the limits page, by key prefix. */
function limitRows(): Map<string, Limit[]> {
  const out = new Map<string, Limit[]>();
  for (const l of page("reference/limits.md").split("\n")) {
    const m = /^\| `([a-z-]+:[a-z]+):[^`]*` \| (\d+) (minute|hour|day)s? \| (\d+) \|/.exec(l);
    if (!m) continue;
    const limit = { seconds: Number(m[2]) * (UNIT[m[3] ?? ""] ?? 0), max: Number(m[4]) };
    out.set(m[1] ?? "", [...(out.get(m[1] ?? "") ?? []), limit]);
  }
  return out;
}

/**
 * The number that `re` captures in `file`, at each match. A unit of KB or MB
 * counts in bytes, as do KiB and MiB (ruling 64 Low 2 of the 12j lane).
 */
function stated(file: string, re: RegExp): number[] {
  const text = page(file);
  const found = [...text.matchAll(new RegExp(re, "g"))].map((m) => {
    const n = Number((m[1] ?? "").replaceAll(" ", ""));
    if (m[2] === "MB" || m[2] === "MiB") return n * 1_048_576;
    return m[2] === "KB" || m[2] === "KiB" ? n * 1024 : n;
  });
  if (found.length === 0) throw new Error(`no match of ${re} in ${file}`);
  return found;
}

describe("the SSO and SCIM limits of the engine and the docs (ruling 74 m1)", () => {
  // Ruling 69 of the 12j lane adds the eighth: the large reads of one user at the SSO writes.
  // Ruling 72 Low 2 adds the ninth: those reads of every user of the deployment together.
  it("are the nine limiter keys of the SSO and SCIM files", () => {
    expect([...engineLimits().keys()].sort()).toEqual([
      "scim-auth:ip",
      "scim:token",
      "sso-acs:ip",
      "sso-discover:ip",
      "sso-domain-verify:org",
      "sso-large-read:deployment",
      "sso-large-read:user",
      "sso-manage:user",
      "sso-start:ip",
    ]);
  });

  it("have one row each, with the same window and count, on the limits page", () => {
    const rows = limitRows();
    for (const [key, limit] of engineLimits())
      expect({ key, page: rows.get(key) }).toEqual({ key, page: [limit] });
  });

  // Each fact: its value in the source, and the pages that state it.
  const facts: [string, () => number, [string, RegExp][]][] = [
    [
      "the live SCIM tokens of one organization",
      () => constant("engine/scim/tokens.ts", "SCIM_TOKENS_LIVE_MAX"),
      [
        ["reference/limits.md", /\| Live SCIM tokens of one organization \| (\d+) \|/],
        ["reference/routes.md", /holds at most (\d+) live tokens: the one in use and the next one/],
        ["guides/scim.mdx", /An organization holds at most (\d+) live tokens/],
      ],
    ],
    [
      "the members of one SCIM group",
      () => constant("engine/scim/limits.ts", "GROUP_MEMBERS_MAX"),
      [
        ["reference/limits.md", /\| Members of one SCIM group \| (\d+) \|/],
        ["reference/routes.md", /A group holds at most (\d+) members/],
        ["reference/routes.md", /`groupMembersMax` (\d+)/],
        ["reference/routes.md", /A page with members holds at most (\d+) member rows/],
      ],
    ],
    [
      "the members that one SCIM request names or takes away",
      () => constant("engine/scim/limits.ts", "PATCH_MEMBERS_MAX"),
      [
        ["reference/limits.md", /\| Members of a group that one SCIM request names \| (\d+),/],
        [
          "reference/limits.md",
          /\| Members of a group that one SCIM request takes away \| (\d+) \|/,
        ],
        ["reference/routes.md", /One request names at most (\d+) members of a group/],
        ["reference/routes.md", /It takes away at most (\d+) members/],
        ["reference/routes.md", /so a PUT of (\d+) members that replaces/],
        ["reference/routes.md", /that replaces (\d+) other members passes/],
        ["reference/routes.md", /`membersPerRequestMax` (\d+)/],
        ["reference/routes.md", /when it holds more than (\d+) members/],
        ["reference/routes.md", /when it takes away more than (\d+) members/],
        ["reference/routes.md", /Okta sends up to (\d+) members in one group PATCH/],
        ["guides/scim.mdx", /One request names at most (\d+) members of a group/],
        ["guides/scim.mdx", /It takes away at most (\d+) members too/],
        ["guides/scim.mdx", /So a PUT of (\d+) members that replaces/],
        ["guides/scim.mdx", /that replaces (\d+) other members passes/],
        ["guides/scim.mdx", /Okta sends up to (\d+) members in one group PATCH/],
        ["guides/scim.mdx", /A request that names more than (\d+) members of a group/],
        ["guides/scim.mdx", /of a group, or takes away more than (\d+) \|/],
        // The known gaps (LO-2 of the review of ruling 84).
        ["guides/scim.mdx", /A PUT with more than (\d+) members answers 400/],
        ["guides/scim.mdx", /a PUT that takes away more than (\d+) members/],
        ["guides/scim.mdx", /A write of (\d+) members whose role changes/],
      ],
    ],
    [
      "the ids of one list statement",
      () => {
        const m = /const LIST_MAX = (\d+) \* INSERT_ROWS_MAX;/.exec(source("storage/sql.ts"));
        return Number(m?.[1]) * constant("storage/sql.ts", "INSERT_ROWS_MAX");
      },
      [["reference/routes.md", /deletes, and updates up to (\d+) ids in one statement/]],
    ],
    [
      "the members of one role recompute",
      () => constant("engine/scim/limits.ts", "GROUP_ROLE_USERS_MAX"),
      [
        ["reference/limits.md", /computes \| (\d+) \|/],
        ["reference/routes.md", /refuses a group of more than (\d+) members/],
        ["reference/routes.md", /`roleRecomputeMax` (\d+)/],
      ],
    ],
    [
      "the results of one SCIM list page",
      () => constant("engine/scim/select.ts", "SCIM_PAGE_MAX"),
      [
        ["reference/limits.md", /\| Results of one SCIM list page \| (\d+) \|/],
        ["reference/routes.md", /filters with at most (\d+) results/],
        ["reference/routes.md", /Users of the organization, by `id`, at most (\d+) per page/],
        ["reference/routes.md", /Groups of the organization, by `id`, at most (\d+) per page/],
      ],
    ],
    [
      "one SCIM request body",
      () => constant("http/routes/scim.ts", "SCIM_BODY_MAX"),
      [
        ["reference/limits.md", /\| One SCIM request body \| (\d+) (MiB) \|/],
        ["guides/scim.mdx", /\| A body over (\d+) (MiB) \|/],
      ],
    ],
    [
      "the metadata XML of a provider",
      () => constant("engine/sso/saml-sp.ts", "IDP_METADATA_MAX"),
      [["reference/limits.md", /\| The metadata XML of a provider \| (\d+) (KB) \|/]],
    ],
    [
      "the SSO connections of one organization by default",
      () => {
        const m = /"connectionsPerOrganization",\s*(\d+),/.exec(source("config.ts"));
        return Number(m?.[1]);
      },
      [["reference/limits.md", /`sso\.limits\.connectionsPerOrganization`, (\d+) by default/]],
    ],
    [
      "the SSO domains of one organization by default",
      () => {
        const m = /"domainsPerOrganization",\s*(\d+)\)/.exec(source("config.ts"));
        return Number(m?.[1]);
      },
      [["reference/limits.md", /`sso\.limits\.domainsPerOrganization`, (\d+) by default/]],
    ],
  ];

  for (const [name, code, pages] of facts)
    it(`state ${name} as the engine holds it`, () => {
      const value = code();
      expect(Number.isFinite(value) && value > 0, name).toBe(true);
      for (const [file, re] of pages)
        for (const n of stated(file, re))
          expect({ file, re: String(re), n }).toEqual({
            file,
            re: String(re),
            n: value,
          });
    });
});
