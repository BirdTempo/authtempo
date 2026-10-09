import { describe, expect, it } from "vitest";
import { sweepExpired } from "../src/engine/sweep.js";
import { makeAuth } from "./helpers.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("sweepExpired", () => {
  it("deletes rows no flow can use and keeps the rest", async () => {
    const { config, storage, clock } = makeAuth();
    const now = clock.now();
    const at = (ms: number) => new Date(now.getTime() + ms);

    const ver = (id: string, expiresAt: Date, consumedAt: Date | null) =>
      storage.create("verification", {
        id,
        purpose: "magic-link",
        identifier: "a@example.com",
        valueHash: `hash-${id}`,
        expiresAt,
        consumedAt,
        data: { next: "/home", n: 1 },
        createdAt: now,
        updatedAt: now,
      });
    const inv = (id: string, expiresAt: Date, acceptedAt: Date | null) =>
      storage.create("invitation", {
        id,
        organizationId: "o1",
        email: `${id}@example.com`,
        role: "member",
        inviterId: "u1",
        tokenHash: `h-${id}`,
        expiresAt,
        acceptedAt,
        createdAt: now,
        updatedAt: now,
      });

    await ver("v-pending", at(HOUR), null);
    await ver("v-expired", at(-HOUR), null);
    await ver("v-consumed-old", at(HOUR), at(-2 * DAY));
    await ver("v-consumed-recent", at(HOUR), at(-2 * HOUR));
    await inv("i-accepted", at(DAY), at(-HOUR));
    await inv("i-pending", at(DAY), null);
    await inv("i-expired", at(-HOUR), null);
    // A limit window that ends before the sweep, and one that is still live.
    await config.limiter.allow("ended", { seconds: 60, max: 3 });
    await config.limiter.allow("live", { seconds: 3600, max: 3 });
    clock.advance(60_000);

    const first = await sweepExpired(config);
    expect(first).toEqual({
      verificationExpired: 1,
      verificationConsumed: 1,
      invitations: 2,
      limits: 1,
    });

    const ids = (await storage.findMany("verification", [])).map((r) => r.id).sort();
    expect(ids).toEqual(["v-consumed-recent", "v-pending"]);
    const invIds = (await storage.findMany("invitation", [])).map((r) => r.id);
    expect(invIds).toEqual(["i-pending"]);

    expect(await sweepExpired(config)).toEqual({
      verificationExpired: 0,
      verificationConsumed: 0,
      invitations: 0,
      limits: 0,
    });
  });
});
