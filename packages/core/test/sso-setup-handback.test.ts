import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, createOrganization } from "../src/engine/organizations.js";
import {
  createSetupLink,
  handBack,
  ownerAddresses,
  revokeSetupLink,
  SETUP_OWNER_SCAN,
} from "../src/engine/sso/setup-links.js";
import { openSetupSession, requireSetupSession } from "../src/engine/sso/setup-session.js";
import { newId } from "../src/primitives/ids.js";
import { IN_CHUNK } from "../src/storage/batch.js";
import { recordAddress, recordCredential } from "./helpers.js";
import { scimAuth } from "./scim/helpers.js";
import { SSO_APP } from "./sso/helpers.js";
import { enrolled, verifiedSession } from "./totp-helpers.js";

const HOUR_MS = 3_600_000;
const META = { ip: recordAddress("198.51.100.9"), userAgent: "setup-handback-test" };
const LOG_METHODS = ["error", "info", "warn", "log", "debug"] as const;
const NOTE = "Ada at Acme IT";
const UNAUTHORIZED = { ok: false, code: "unauthorized", status: 401 };

beforeEach(() => {
  for (const m of LOG_METHODS) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  SETUP_OWNER_SCAN.pageSize = 100;
  SETUP_OWNER_SCAN.maxPages = 1000;
});

type Event = { organizationId: string; linkId: string };

/**
 * The world of `scimAuth` (organization acme, one owner) with SSO setup on and a recorded hook.
 * `hook` replaces the recording hook. `readyAtSeen` holds the `readyAt` that the hook read from
 * storage at its call, so a test proves that the hook runs after the commit.
 */
async function world(hook?: (e: Event) => unknown) {
  const events: Event[] = [];
  const readyAtSeen: (Date | null)[] = [];
  const ref: { w: Awaited<ReturnType<typeof scimAuth>> | null } = { w: null };
  const w = await scimAuth({
    sso: { oidc: true, saml: true, setup: {} },
    hooks: {
      sso: {
        async setupReady(e) {
          events.push(e);
          const row = await ref.w?.storage.findOne("ssoSetupLink", [
            { field: "id", op: "eq", value: e.linkId },
          ]);
          readyAtSeen.push(row?.readyAt ?? null);
          if (hook) await hook(e);
        },
      },
    },
  });
  ref.w = w;
  return { w, events, readyAtSeen };
}
type W = Awaited<ReturnType<typeof world>>["w"];

/** A second owner of the organization, with a verified address. */
async function secondOwner(w: W, email: string, org = w.org) {
  const user = await verifiedSession(w, email);
  const added = await addMember(w.config, {
    user: (
      await w.storage.findMany("user", [{ field: "email", op: "eq", value: "owner@acme.example" }])
    )[0] as never,
    organizationId: org,
    userId: user.user.id,
    role: "owner",
  });
  if (!added.ok) throw new Error(added.code);
  return user.user;
}

/** A setup session through the real link, open, and cookie check. The token and the cookie are recorded. */
async function session(w: W, organizationId = w.org, note = NOTE) {
  const made = await createSetupLink(w.config, SSO_APP, {
    organizationId,
    steps: ["domain", "connection"],
    kinds: ["oidc"],
    note,
  });
  if (!made.ok) throw new Error(made.code);
  recordCredential(made.value.token);
  const opened = await openSetupSession(w.config, made.value.token, META);
  if (!opened.ok) throw new Error(opened.code);
  const pair = opened.value.cookie.split(";")[0] ?? "";
  const cookie = pair.split("=")[1] ?? "";
  recordCredential(cookie);
  const checked = await requireSetupSession(
    w.config,
    new Request("https://auth.example/auth/sso/setup/status", { headers: { cookie: pair } }),
  );
  if (!checked.ok) throw new Error(checked.code);
  return { s: checked.value, token: made.value.token, cookie };
}

/**
 * A member row of acme with a seeded user, one second after the last row, so the member ids
 * sort in the order of the calls. The row is what `addMember` writes; the call would need the
 * rank checks of a caller for each of 120 rows.
 */
async function ownerRow(w: W, email: string, role: string) {
  const user = await w.seedUser(email);
  w.clock.advance(1000);
  const now = w.clock.now();
  await w.storage.create("member", {
    id: newId(now),
    createdAt: now,
    updatedAt: now,
    organizationId: w.org,
    userId: user.id,
    role,
  });
}

const readyNotices = (w: W) => w.mail.filter((m) => m.subject.startsWith("SSO setup notice"));
const linkRow = (w: W, id: string) =>
  w.storage.findOne("ssoSetupLink", [{ field: "id", op: "eq", value: id }]);

describe("the hand back of a setup link (plan 13a Task 10)", () => {
  it("sends one notice to each owner that names the note and the link id, and no token", async () => {
    const { w } = await world();
    await secondOwner(w, "second@acme.example");
    const { s, token, cookie } = await session(w);
    expect(await handBack(w.config, s)).toEqual({ ok: true, value: undefined });
    const sent = readyNotices(w);
    expect(sent.map((m) => m.to).sort()).toEqual(["owner@acme.example", "second@acme.example"]);
    for (const m of sent) {
      expect(m.text).toContain(NOTE);
      expect(m.text).toContain(s.link.id);
      expect(m.text).not.toContain(token);
      expect(m.text).not.toContain(cookie);
      expect(m.text).not.toContain(s.link.tokenHash);
    }
    const everything = JSON.stringify([
      w.mail,
      await w.storage.findMany("operatorAudit", []),
      LOG_METHODS.map((m) => vi.mocked(console[m]).mock.calls),
    ]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(cookie);
    expect((await linkRow(w, s.link.id))?.readyAt).toEqual(w.clock.now());
  });

  it("sends the notice to no member below the owner rank", async () => {
    const { w } = await world();
    const member = await verifiedSession(w, "admin@acme.example");
    const owner = (
      await w.storage.findMany("user", [{ field: "email", op: "eq", value: "owner@acme.example" }])
    )[0];
    const added = await addMember(w.config, {
      user: owner as never,
      organizationId: w.org,
      userId: member.user.id,
      role: "admin",
    });
    expect(added.ok).toBe(true);
    const { s } = await session(w);
    await handBack(w.config, s);
    expect(readyNotices(w).map((m) => m.to)).toEqual(["owner@acme.example"]);
  });

  it("calls the hook once, after the commit, with the organization and the link", async () => {
    const { w, events, readyAtSeen } = await world();
    const { s } = await session(w);
    await handBack(w.config, s);
    expect(events).toEqual([{ organizationId: w.org, linkId: s.link.id }]);
    expect(readyAtSeen).toEqual([w.clock.now()]);
  });

  it("keeps the commit and sends the mail when the hook throws", async () => {
    const { w, events } = await world(() => {
      throw new Error("hook broke");
    });
    const { s } = await session(w);
    expect(await handBack(w.config, s)).toEqual({ ok: true, value: undefined });
    expect(events).toHaveLength(1);
    expect((await linkRow(w, s.link.id))?.readyAt).toEqual(w.clock.now());
    expect(readyNotices(w)).toHaveLength(1);
    expect(
      vi
        .mocked(console.error)
        .mock.calls.map((c) => JSON.stringify(c))
        .join("\n"),
    ).toContain("after hook failed");
  });

  it("keeps the commit and runs the hook when the owner scan fails", async () => {
    const { w, events } = await world();
    const { s } = await session(w);
    // The member read fails after the commit. The transaction runs on the real adapter.
    const failing = new Proxy(w.storage, {
      get(target, prop) {
        if (prop === "findMany")
          return (model: string, ...rest: unknown[]) => {
            if (model === "member") throw new Error("scan broke owner@acme.example");
            return (target.findMany as (...a: unknown[]) => unknown)(model, ...rest);
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect(await handBack({ ...w.config, storage: failing }, s)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(events).toHaveLength(1);
    expect((await linkRow(w, s.link.id))?.readyAt).toEqual(w.clock.now());
    expect(readyNotices(w)).toEqual([]);
    const lines = vi
      .mocked(console.error)
      .mock.calls.map((c) => JSON.stringify(c))
      .join("\n");
    expect(lines).toContain("notice mail failed");
    expect(lines).not.toContain("owner@acme.example");
  });

  it("mails every owner of an organization with more than 50 owners", async () => {
    const { w } = await world();
    for (let i = 0; i < 52; i++) await ownerRow(w, `extra${i}@acme.example`, "owner");
    const { s } = await session(w);
    await handBack(w.config, s);
    expect(readyNotices(w)).toHaveLength(53);
  });

  // Final review I1: the read drops each row that holds exactly one role below the owner rank. A
  // comma list stays in the read, because its parts have no fixed order. So the tests of the pages
  // below fill the pages with comma lists below the owner rank.
  it("reads the owners only: an owner after 5 single-role members is in the first page, and no warning line", async () => {
    const { w } = await world();
    const { s } = await session(w);
    SETUP_OWNER_SCAN.pageSize = 2;
    SETUP_OWNER_SCAN.maxPages = 1;
    for (let i = 0; i < 5; i++) await ownerRow(w, `viewer${i}@acme.example`, "viewer");
    await ownerRow(w, "late@acme.example", "owner");
    await handBack(w.config, s);
    expect(readyNotices(w).map((m) => m.to)).toEqual(["owner@acme.example", "late@acme.example"]);
    const lines = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(lines).not.toContain("notice mail failed");
  });

  it("reads with no role term when the role names below the owner rank pass the D1 bound of 50", async () => {
    const { w } = await world();
    const o = w.config.organizations;
    if (!o) throw new Error("no organizations");
    const viewer = o.roles.viewer;
    if (!viewer) throw new Error("no viewer role");
    const ranks = { ...o.ranks };
    const roles = { ...o.roles };
    for (let i = 0; i <= IN_CHUNK; i++) {
      ranks[`extra${i}`] = viewer.rank;
      roles[`extra${i}`] = viewer;
    }
    const wide = { ...w.config, organizations: { ...o, ranks, roles } };
    for (let i = 0; i < 3; i++) await ownerRow(w, `viewer${i}@acme.example`, "viewer");
    await ownerRow(w, "late@acme.example", "owner");
    const reads = vi.spyOn(w.config.storage, "findMany");
    const roleTerms = () =>
      reads.mock.calls
        .filter(([model]) => model === "member")
        .map(([, where]) => where.filter((t) => t.field === "role").length);
    const owners = { addresses: ["owner@acme.example", "late@acme.example"], complete: true };
    expect(await ownerAddresses(w.config, w.org)).toEqual({ ...owners, owners: 2 });
    const narrow = roleTerms();
    reads.mockClear();
    expect(await ownerAddresses(wide, w.org)).toEqual({ ...owners, owners: 2 });
    // The table of the test has 3 names below the owner rank; the wide table has 54.
    expect([narrow, roleTerms()]).toEqual([[3], [0]]);
  });

  it("reads every page: an owner after 120 comma members still gets the notice", async () => {
    const { w, events } = await world();
    const { s } = await session(w);
    SETUP_OWNER_SCAN.pageSize = 2;
    for (let i = 0; i < 120; i++) await ownerRow(w, `viewer${i}@acme.example`, "viewer,member");
    await ownerRow(w, "late@acme.example", "member,owner");
    await handBack(w.config, s);
    expect(readyNotices(w).map((m) => m.to)).toEqual(["owner@acme.example", "late@acme.example"]);
    expect(events).toHaveLength(1);
  });

  // Plan 13b Task 12 (review M1): each read takes one row more than the page. The cursor is the
  // last row of the page, not the extra row, so the extra row is the first row of the next page.
  it("reads the extra row again: an owner at each third position gets the notice", async () => {
    const { w } = await world();
    const { s } = await session(w);
    SETUP_OWNER_SCAN.pageSize = 2;
    // The first owner holds position 1. Positions 3, 6, and 9 are the extra rows of the reads.
    for (let p = 2; p <= 9; p++)
      await ownerRow(w, `p${p}@acme.example`, p % 3 === 0 ? "owner" : "viewer,member");
    await handBack(w.config, s);
    expect(readyNotices(w).map((m) => m.to)).toEqual([
      "owner@acme.example",
      "p3@acme.example",
      "p6@acme.example",
      "p9@acme.example",
    ]);
  });

  it("ends complete at an exact page multiple: 6 members in 3 pages of 2, and no warning line", async () => {
    const { w } = await world();
    const { s } = await session(w);
    SETUP_OWNER_SCAN.pageSize = 2;
    SETUP_OWNER_SCAN.maxPages = 3;
    for (let p = 2; p <= 5; p++) await ownerRow(w, `p${p}@acme.example`, "viewer,member");
    await ownerRow(w, "p6@acme.example", "owner");
    await handBack(w.config, s);
    expect(readyNotices(w).map((m) => m.to)).toEqual(["owner@acme.example", "p6@acme.example"]);
    const lines = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(lines).not.toContain("notice mail failed");
  });

  it("writes one warning line and still runs the hook when the safety bound ends the scan", async () => {
    const { w, events } = await world();
    const { s } = await session(w);
    SETUP_OWNER_SCAN.pageSize = 2;
    SETUP_OWNER_SCAN.maxPages = 2;
    for (let i = 0; i < 5; i++) await ownerRow(w, `viewer${i}@acme.example`, "viewer,member");
    await ownerRow(w, "late@acme.example", "owner");
    await handBack(w.config, s);
    expect(readyNotices(w).map((m) => m.to)).toEqual(["owner@acme.example"]);
    expect(events).toHaveLength(1);
    const lines = vi
      .mocked(console.error)
      .mock.calls.map((c) => JSON.stringify(c))
      .join("\n");
    expect(lines).toContain("notice mail failed");
    expect(lines).toContain("RangeError");
  });

  it("does nothing a second time: no mail, no hook, the same readyAt", async () => {
    const { w, events } = await world();
    const { s } = await session(w);
    await handBack(w.config, s);
    const first = (await linkRow(w, s.link.id))?.readyAt;
    w.clock.advance(HOUR_MS);
    expect(await handBack(w.config, s)).toEqual({ ok: true, value: undefined });
    expect(readyNotices(w)).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect((await linkRow(w, s.link.id))?.readyAt).toEqual(first);
  });

  it("answers ok, with the hook, for an organization that has no owner", async () => {
    const { w, events } = await world();
    const { s } = await session(w);
    await w.storage.delete("member", [{ field: "organizationId", op: "eq", value: w.org }]);
    expect(await handBack(w.config, s)).toEqual({ ok: true, value: undefined });
    expect(readyNotices(w)).toEqual([]);
    expect(events).toHaveLength(1);
    expect((await linkRow(w, s.link.id))?.readyAt).not.toBeNull();
  });

  it("does not stop at an owner with no address", async () => {
    const { w } = await world();
    const other = await verifiedSession(w, "phone@acme.example");
    await w.storage.update("user", [{ field: "id", op: "eq", value: other.user.id }], {
      email: null,
    });
    const owner = (
      await w.storage.findMany("user", [{ field: "email", op: "eq", value: "owner@acme.example" }])
    )[0];
    await addMember(w.config, {
      user: owner as never,
      organizationId: w.org,
      userId: other.user.id,
      role: "owner",
    });
    const { s } = await session(w);
    expect(await handBack(w.config, s)).toEqual({ ok: true, value: undefined });
    expect(readyNotices(w).map((m) => m.to)).toEqual(["owner@acme.example"]);
  });

  it("reaches only the owners and the link of its own organization", async () => {
    const { w, events } = await world();
    const bob = await enrolled(w, "owner@beta.example");
    const beta = await createOrganization(w.config, { user: bob.user, slug: "beta", name: "Beta" });
    if (!beta.ok) throw new Error(beta.code);
    const acme = await session(w);
    const other = await session(w, beta.value.organization.id, "Bo at Beta IT");
    await handBack(w.config, acme.s);
    expect(readyNotices(w).map((m) => m.to)).toEqual(["owner@acme.example"]);
    expect(events).toEqual([{ organizationId: w.org, linkId: acme.s.link.id }]);
    expect((await linkRow(w, other.s.link.id))?.readyAt).toBeNull();
    await handBack(w.config, other.s);
    expect(readyNotices(w).map((m) => [m.to, m.text.includes("Bo at Beta IT")])).toEqual([
      ["owner@acme.example", false],
      ["owner@beta.example", true],
    ]);
  });

  it("refuses a link that a manager revoked: no readyAt, no mail, no hook", async () => {
    const { w, events } = await world();
    const { s } = await session(w);
    expect(await revokeSetupLink(w.config, SSO_APP, s.link.id)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await handBack(w.config, s)).toEqual(UNAUTHORIZED);
    expect(readyNotices(w)).toEqual([]);
    expect(events).toEqual([]);
    expect((await linkRow(w, s.link.id))?.readyAt).toBeNull();
  });

  it("answers not_found while sso.setup is off", async () => {
    const { w, events } = await world();
    const { s } = await session(w);
    const off = { ...w.config, sso: w.config.sso && { ...w.config.sso, setup: false as const } };
    expect(await handBack(off, s)).toMatchObject({ ok: false, code: "not_found" });
    expect(events).toEqual([]);
    expect((await linkRow(w, s.link.id))?.readyAt).toBeNull();
  });
});
