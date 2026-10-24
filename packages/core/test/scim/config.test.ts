import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { makeAuth } from "../helpers.js";

const ORGS = {
  platformRole: "operator",
  platformOrganization: "platform-co",
  ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
};

/** The ConfigError text of one config, or the resolved `scim`. */
function scimOf(config: Partial<AuthConfig>) {
  try {
    return makeAuth(config).config.scim;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("the scim config (plan 12d Task 9 Behavior 11)", () => {
  it("resolves the defaults and each allowed value", () => {
    expect(scimOf({})).toBeNull();
    expect(scimOf({ organizations: ORGS, scim: false })).toBeNull();
    expect(scimOf({ organizations: ORGS, scim: {} })).toEqual({
      groups: "roles",
      defaultRole: "member",
    });
    expect(
      scimOf({
        organizations: { ...ORGS, teams: {} },
        scim: { groups: "both", defaultRole: "viewer,admin" },
      }),
    ).toEqual({ groups: "both", defaultRole: "viewer,admin" });
  });

  it("refuses each setting outside its rule with a text that names the key", () => {
    const rows: [Partial<AuthConfig>, string][] = [
      [{ scim: {} }, "scim needs organizations"],
      // Plan 12d Task 10: only a SCIM write runs hooks.scim.
      [
        { organizations: ORGS, hooks: { scim: { afterChange: () => {} } } },
        "hooks.scim needs scim: the hooks would never run",
      ],
      [{ organizations: ORGS, scim: [] as never }, "scim must be an object or false"],
      [
        { organizations: ORGS, scim: { tokens: 3 } as never },
        "scim.tokens is not an option; core has groups and defaultRole",
      ],
      [
        { organizations: ORGS, scim: { groups: "people" } as never },
        "scim.groups must be roles, teams, or both",
      ],
      [
        { organizations: ORGS, scim: { groups: "teams" } },
        "scim.groups teams needs organizations.teams",
      ],
      [
        { organizations: ORGS, scim: { groups: "both" } },
        "scim.groups both needs organizations.teams",
      ],
      [
        { organizations: ORGS, scim: { defaultRole: "guest" } },
        "scim.defaultRole must be a role of the role table",
      ],
      [
        { organizations: ORGS, scim: { defaultRole: "member,guest" } },
        "scim.defaultRole must be a role of the role table",
      ],
      [
        { organizations: ORGS, scim: { defaultRole: "owner" } },
        "scim.defaultRole must rank below owner",
      ],
      [
        { organizations: ORGS, scim: { defaultRole: "member,owner" } },
        "scim.defaultRole must rank below owner",
      ],
      [
        {
          organizations: { ...ORGS, ranks: { ...ORGS.ranks, operator: 3 } },
          scim: { defaultRole: "operator" },
        },
        "scim.defaultRole must not hold the platform role",
      ],
      // The default role must be in the table too.
      [
        { organizations: { ranks: { viewer: 1, owner: 4 } }, scim: {} },
        "scim.defaultRole must be a role of the role table",
      ],
    ];
    for (const [config, text] of rows)
      expect([JSON.stringify(config.scim), scimOf(config)]).toEqual([
        JSON.stringify(config.scim),
        text,
      ]);
  });
});
