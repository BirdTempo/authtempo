import { describe, expect, it } from "vitest";
import { SETUP_RETENTION_MS } from "../src/engine/sso/setup-retention.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { newId } from "../src/primitives/ids.js";
import { ssoAuth } from "./sso/helpers.js";

/**
 * Plan 13a fix wave, ruling R30: the sweep deletes the setup links and the setup sessions that
 * ended long ago, and the test runs of that age. A link holds the name of an IT contact in
 * `note`, so a deleted link takes the note with it.
 */

const DAY = 86_400_000;

function world(setup: boolean) {
  const w = ssoAuth({
    sso: setup ? { oidc: true, setup: {} } : { oidc: true },
    scim: {},
  });
  const at = (ms: number) => new Date(w.clock.now().getTime() + ms);
  /** A SCIM token row. `linkId` null is a token of the manager. */
  const token = async (name: string, linkId: string | null, pending: boolean) => {
    const now = w.clock.now();
    const id = newId(now);
    await w.storage.create("scimToken", {
      id,
      createdAt: now,
      updatedAt: now,
      organizationId: "org1",
      name: `Token ${name}`,
      tokenHash: `thash-${name}`,
      hint: "abcd",
      scopes: ["scim.users.read"],
      expiresAt: null,
      lastUsedAt: null,
      pending,
      setupLinkId: linkId,
      expiryStage: null,
      expiryNoticeAt: null,
    });
    return id;
  };
  /** A link whose `expiresAt` is `expiresIn` ms from now. */
  const link = async (name: string, expiresIn: number) => {
    const now = w.clock.now();
    const id = newId(now);
    await w.storage.create("ssoSetupLink", {
      id,
      createdAt: now,
      updatedAt: now,
      organizationId: "org1",
      tokenHash: `hash-${name}`,
      hint: "abcd",
      steps: ["domain"],
      kinds: ["oidc"],
      note: `Contact ${name}`,
      createdBy: "u1",
      expiresAt: at(expiresIn),
      revokedAt: null,
      endedAt: null,
      openedAt: null,
      readyAt: null,
      expiryStage: null,
      expiryNoticeAt: null,
    });
    return id;
  };
  const session = async (name: string, linkId: string, expiresIn: number) => {
    const now = w.clock.now();
    const id = newId(now);
    await w.storage.create("ssoSetupSession", {
      id,
      createdAt: now,
      updatedAt: now,
      linkId,
      organizationId: "org1",
      tokenHash: `shash-${name}`,
      lastSeenAt: now,
      expiresAt: at(expiresIn),
      endedAt: null,
    });
    return id;
  };
  const run = async (name: string, createdIn: number) => {
    const made = at(createdIn);
    const id = newId(made);
    await w.storage.create("ssoTestRun", {
      id,
      createdAt: made,
      updatedAt: made,
      organizationId: "org1",
      connectionId: `con-${name}`,
      linkId: null,
      outcome: "passed",
      step: null,
      attributeNames: [],
      domainClaimed: false,
      draftVersion: 1,
    });
    return id;
  };
  const ids = async (model: "ssoSetupLink" | "ssoSetupSession" | "ssoTestRun") =>
    (await w.storage.findMany(model, [])).map((r) => r.id).sort();
  const tokens = async () => (await w.storage.findMany("scimToken", [])).map((t) => t.id).sort();
  return { w, link, session, run, token, tokens, ids };
}

describe("the sweep of the setup rows (R30)", () => {
  it("deletes the links, sessions and runs past the retention, and keeps the rest", async () => {
    const { w, link, session, run, ids } = world(true);
    const old = await link("old", -(SETUP_RETENTION_MS + DAY));
    const recent = await link("recent", -DAY);
    const live = await link("live", DAY);
    const oldSession = await session("old", live, -(SETUP_RETENTION_MS + DAY));
    const recentSession = await session("recent", live, -DAY);
    const oldRun = await run("old", -(SETUP_RETENTION_MS + DAY));
    const recentRun = await run("recent", -DAY);

    const result = await sweepExpired(w.config);

    expect(result.ssoSetupRows).toBe(3);
    expect(await ids("ssoSetupLink")).toEqual([recent, live].sort());
    expect(await ids("ssoSetupSession")).toEqual([recentSession]);
    expect(await ids("ssoTestRun")).toEqual([recentRun]);
    // The note of the old link goes with its row. No other row keeps the name.
    const notes = (await w.storage.findMany("ssoSetupLink", [])).map((l) => l.note).sort();
    expect(notes).toEqual(["Contact live", "Contact recent"]);
    const left = [...(await ids("ssoSetupLink")), ...(await ids("ssoSetupSession"))];
    expect(left).not.toContain(old);
    expect(left).not.toContain(oldSession);
    expect(await ids("ssoTestRun")).not.toContain(oldRun);
  });

  it("sweeps while sso is on and sso.setup is off: a link that was minted before setup went off still goes", async () => {
    const { w, link, ids } = world(false);
    await link("old", -(SETUP_RETENTION_MS + DAY));
    const result = await sweepExpired(w.config);
    expect(result.ssoSetupRows).toBe(1);
    expect(await ids("ssoSetupLink")).toHaveLength(0);
  });

  it("leaves the rows for the next sweep when fewer than 5 calls stay, so it never takes a call from a step that a user waits for", async () => {
    const { w, link, ids } = world(true);
    await link("old", -(SETUP_RETENTION_MS + DAY));
    // A storage that reports 46 statements for the sweep: 4 calls stay of the budget of 50.
    let reads = 0;
    const full = new Proxy(w.config.storage, {
      get(target, key) {
        if (key === "statementsSent") return () => (reads++ === 0 ? 0 : 46);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await sweepExpired({ ...w.config, storage: full });
    expect(result.ssoSetupRows).toBe(0);
    expect(await ids("ssoSetupLink")).toHaveLength(1);
    // The next sweep, with room, deletes it.
    expect((await sweepExpired(w.config)).ssoSetupRows).toBe(1);
  });

  it("sweeps nothing and counts 0 while sso is off", async () => {
    const w = ssoAuth({});
    const result = await sweepExpired({ ...w.config, sso: null });
    expect(result.ssoSetupRows).toBe(0);
  });

  it("deletes the pending token of a deleted link, and keeps every other token", async () => {
    const { w, link, token, tokens } = world(true);
    const old = await link("old", -(SETUP_RETENTION_MS + DAY));
    const recent = await link("recent", -DAY);
    await token("pending-old", old, true);
    const keptRecent = await token("pending-recent", recent, true);
    // An activated token has `pending` false. A deleted link must not take it.
    const activated = await token("activated-old", old, false);
    const manager = await token("manager", null, false);
    await sweepExpired(w.config);
    expect(await tokens()).toEqual([keptRecent, activated, manager].sort());
  });

  it("keeps a link, a session, and a run at the edge, and deletes them one millisecond past it", async () => {
    const { w, link, session, run, ids } = world(true);
    const live = await link("live", DAY);
    // A row that ends exactly now is not past its end: it stays.
    const endsNow = await link("ends-now", 0);
    const sessionNow = await session("ends-now", live, 0);
    // Exactly the retention after the end: the delete is `lt`, so the row stays.
    const atEdge = await link("edge", -SETUP_RETENTION_MS);
    const sessionEdge = await session("edge", live, -SETUP_RETENTION_MS);
    const runEdge = await run("edge", -SETUP_RETENTION_MS);
    // One millisecond past the edge: the row goes.
    await link("past", -SETUP_RETENTION_MS - 1);
    await session("past", live, -SETUP_RETENTION_MS - 1);
    await run("past", -SETUP_RETENTION_MS - 1);
    const result = await sweepExpired(w.config);
    expect(result.ssoSetupRows).toBe(3);
    expect(await ids("ssoSetupLink")).toEqual([live, endsNow, atEdge].sort());
    expect(await ids("ssoSetupSession")).toEqual([sessionNow, sessionEdge].sort());
    expect(await ids("ssoTestRun")).toEqual([runEdge]);
  });
});
