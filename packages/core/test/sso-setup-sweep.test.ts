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
  const w = ssoAuth({ sso: setup ? { oidc: true, setup: {} } : { oidc: true } });
  const at = (ms: number) => new Date(w.clock.now().getTime() + ms);
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
  return { w, link, session, run, ids };
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

  it("sweeps nothing and counts 0 while sso.setup is off", async () => {
    const { w, link, ids } = world(false);
    await link("old", -(SETUP_RETENTION_MS + DAY));
    const result = await sweepExpired(w.config);
    expect(result.ssoSetupRows).toBe(0);
    expect(await ids("ssoSetupLink")).toHaveLength(1);
  });
});
