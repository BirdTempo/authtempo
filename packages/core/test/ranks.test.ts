import { describe, expect, it } from "vitest";
import { needs, normalizeSlug, ROLE_RE, rankOf, roleAllowedIn } from "../src/engine/ranks.js";
import { makeAuth } from "./helpers.js";

const RANKS = { viewer: 1, member: 2, admin: 3, owner: 4 };

describe("rankOf", () => {
  it("takes the highest rank among comma-separated parts, and 0 for an unknown part (Review Focus 1)", () => {
    expect(rankOf(RANKS, "owner")).toBe(4);
    expect(rankOf(RANKS, "member,admin")).toBe(3);
    expect(rankOf(RANKS, "owner,bogus")).toBe(4);
    expect(rankOf(RANKS, "bogus")).toBe(0);
    expect(rankOf(RANKS, "")).toBe(0);
  });
  it("accepts the role shape and refuses spaces, upper case, and an empty part", () => {
    for (const ok of ["owner", "a,b", "role_1-x"]) expect(ROLE_RE.test(ok)).toBe(true);
    for (const bad of ["Owner", "a, b", "a,,b", ",a", "", "x".repeat(65)])
      expect(ROLE_RE.test(bad)).toBe(false);
  });
});

describe("normalizeSlug", () => {
  it("normalizes NFKC and lower case, and refuses a bad shape (Review Focus 4)", () => {
    expect(normalizeSlug("ＡＤＭＩＮ")).toBe("admin");
    expect(normalizeSlug("My-Org")).toBe("my-org");
    expect(normalizeSlug("My Org")).toBeNull();
    expect(normalizeSlug("-org")).toBeNull();
    expect(normalizeSlug("org-")).toBeNull();
    expect(normalizeSlug("a")).toBe("a");
    expect(normalizeSlug("a".repeat(64))).toBe("a".repeat(64));
    expect(normalizeSlug("a".repeat(65))).toBeNull();
    expect(normalizeSlug("ö")).toBeNull();
  });
});

describe("organizations config", () => {
  it("is off by default and with false, on with {} and the defaults", () => {
    expect(makeAuth().config.organizations).toBeNull();
    expect(makeAuth({ organizations: false }).config.organizations).toBeNull();
    const on = makeAuth({ organizations: {} }).config.organizations;
    expect(on?.ranks).toEqual(RANKS);
    expect([...(on?.reservedSlugs ?? [])].sort()).toEqual([
      "admin",
      "api",
      "auth",
      "internal",
      "operator",
      "ops",
      "platform",
      "system",
      "www",
    ]);
    expect(on?.invitationTtlDays).toBe(7);
    expect(on?.invitationLinkBuilder("inv_x", { slug: "s", name: "n" })).toBe(
      "https://api.example.com/?invitation=inv_x",
    );
  });
  it("refuses a rank table with a non-positive rank, a reserved slug that does not normalize, and a platform role outside the table", () => {
    expect(() => makeAuth({ organizations: { ranks: { a: 0 } } })).toThrow(/ranks/);
    expect(() => makeAuth({ organizations: { reservedSlugs: ["Bad Slug"] } })).toThrow(
      /reservedSlugs/,
    );
    expect(() => makeAuth({ organizations: { platformRole: "operator" } })).toThrow(/platformRole/);
    expect(() =>
      makeAuth({ organizations: { platformRole: "operator", ranks: { ...RANKS, operator: 5 } } }),
    ).toThrow(/platformOrganization/);
    const ok = makeAuth({
      organizations: {
        platformRole: "operator",
        platformOrganization: "Platform-Co",
        ranks: { ...RANKS, operator: 5 },
      },
    }).config.organizations;
    expect(ok?.platformOrganization).toBe("platform-co");
  });
  it("needs() reads the rule table against the rank table", () => {
    const c = makeAuth({ organizations: {} }).config.organizations;
    if (!c) throw new Error("off");
    expect(needs(c, "delete")).toBe(4);
    expect(needs(c, "invite")).toBe(3);
    expect(needs(c, "members")).toBe(1);
    const custom = makeAuth({ organizations: { ranks: { reader: 1, editor: 2, owner: 3 } } }).config
      .organizations;
    if (!custom) throw new Error("off");
    // A rule names a role the table lacks: the rule needs the highest rank, so it fails closed.
    expect(needs(custom, "invite")).toBe(3);
  });
  it("roleAllowedIn refuses the platform role outside the platform organization", () => {
    const c = makeAuth({
      organizations: {
        platformRole: "operator",
        platformOrganization: "platform-co",
        ranks: { ...RANKS, operator: 5 },
      },
    }).config.organizations;
    if (!c) throw new Error("off");
    expect(roleAllowedIn(c, "operator", "platform-co")).toBe(true);
    expect(roleAllowedIn(c, "admin,operator", "other")).toBe(false);
    expect(roleAllowedIn(c, "admin", "other")).toBe(true);
    expect(
      roleAllowedIn(makeAuth({ organizations: {} }).config.organizations ?? c, "operator", "x"),
    ).toBe(true);
  });
});
