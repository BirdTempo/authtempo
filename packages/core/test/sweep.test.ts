import { describe, expect, it } from "vitest";
import { sweepExpired } from "../src/engine/sweep.js";
import { makeAuth } from "./helpers.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("sweepExpired", () => {
  it("deletes rows no flow can use and keeps the rest", async () => {
    // A magic link ttl of three days makes a consumed row that is still
    // before its expiry one day after the consume. The second verification
    // delete exists for that case only.
    const { config, storage, clock } = makeAuth({ magicLink: { ttlMinutes: 3 * 24 * 60 } });
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
    const session = (id: string, expiresAt: Date) =>
      storage.create("session", {
        id,
        userId: "u1",
        tokenHash: `s-${id}`,
        expiresAt,
        lastSeenAt: now,
        ip: "1.1.1.1",
        userAgent: "ua",
        activeOrganizationId: null,
        createdAt: now,
        updatedAt: now,
      });

    // Each row is one the product can write. A consumed row was consumed
    // before its expiry.
    await ver("v-pending", at(10 * MINUTE), null);
    await ver("v-expired", at(-HOUR), null);
    await ver("v-consumed-expired", at(-HOUR), at(-HOUR - 5 * MINUTE));
    await ver("v-consumed-live", at(10 * MINUTE), at(-MINUTE));
    // Made two and a half days ago under the three-day ttl, consumed two days ago.
    await ver("v-consumed-long", at(DAY / 2), at(-2 * DAY));
    await inv("i-accepted", at(DAY), at(-HOUR));
    await inv("i-pending", at(DAY), null);
    await inv("i-expired", at(-HOUR), null);
    await inv("i-accepted-expired", at(-HOUR), at(-2 * HOUR));
    await session("s-expired", at(-HOUR));
    await session("s-live", at(DAY));
    // A limit window that ends before the sweep, and one that is still live.
    await config.limiter.allow("ended", { seconds: 60, max: 3 });
    await config.limiter.allow("live", { seconds: 3600, max: 3 });
    clock.advance(60_000);

    const first = await sweepExpired(config);
    expect(first).toEqual({
      verificationExpired: 2,
      verificationConsumed: 1,
      invitations: 3,
      sessions: 1,
      limits: 1,
    });

    const ids = (await storage.findMany("verification", [])).map((r) => r.id).sort();
    expect(ids).toEqual(["v-consumed-live", "v-pending"]);
    const invIds = (await storage.findMany("invitation", [])).map((r) => r.id);
    expect(invIds).toEqual(["i-pending"]);
    const sessionIds = (await storage.findMany("session", [])).map((r) => r.id);
    expect(sessionIds).toEqual(["s-live"]);

    expect(await sweepExpired(config)).toEqual({
      verificationExpired: 0,
      verificationConsumed: 0,
      invitations: 0,
      sessions: 0,
      limits: 0,
    });
  });
});
