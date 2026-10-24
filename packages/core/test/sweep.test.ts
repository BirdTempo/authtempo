import { describe, expect, it } from "vitest";
import { findClient, publicClientFields } from "../src/engine/oauth-clients.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { setupTotp } from "../src/engine/totp.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth, post } from "./helpers.js";
import { oauthHandle } from "./oauth-helpers.js";
import { enrolled, PASSWORD, totpAuth, verifiedSession } from "./totp-helpers.js";

/**
 * The one node:fs call the README check uses. Core's typecheck has no Node
 * types, because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck (as session-hooks.test.ts does).
 */
interface ReadmeFs {
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

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
        secretVersion: 1,
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
        teamIds: null,
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
        freshAt: now,
        actorId: null,
        activeTeamId: null,
        createdAt: now,
        updatedAt: now,
      });
    const token = (id: string, expiresAt: Date | null) =>
      storage.create("apiToken", {
        id,
        userId: "u1",
        name: id,
        tokenHash: `t-${id}`,
        hint: "abcdefgh",
        expiresAt,
        lastUsedAt: null,
        organizationId: null,
        permissions: null,
        metadata: null,
        rateLimitSeconds: null,
        rateLimitMax: null,
        remaining: null,
        refillAmount: null,
        refillSeconds: null,
        lastRefillAt: null,
        retiredAt: null,
        createdAt: now,
        updatedAt: now,
      });
    const device = (id: string, expiresAt: Date) =>
      storage.create("trustedDevice", {
        id,
        userId: "u1",
        tokenHash: `d-${id}`,
        expiresAt,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
    const key = (id: string, slot: string | null, retiredAt: Date | null) =>
      storage.create("jwk", {
        id,
        publicJwk: { kid: id },
        privateKey: "sealed",
        slot,
        retiredAt,
        createdAt: now,
        updatedAt: now,
        secretVersion: 1,
      });
    const client = (id: string, lastSeenAt: Date) =>
      storage.create("oauthClient", {
        id,
        kind: "registered",
        name: null,
        redirectUris: ["https://client.example.com/cb"],
        lastSeenAt,
        createdAt: now,
        updatedAt: now,
        ...publicClientFields(),
      });
    const refresh = (id: string, clientId: string, expiresAt: Date) =>
      storage.create("oauthToken", {
        id,
        tokenHash: `r-${id}`,
        familyId: `f-${id}`,
        userId: "u1",
        clientId,
        scopes: ["offline_access"],
        resource: "https://api.example.com/mcp",
        expiresAt,
        usedAt: null,
        parentId: null,
        dpopJkt: null,
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
    await token("t-expired", at(-HOUR));
    await token("t-live", at(DAY));
    await token("t-forever", null);
    await device("d-expired", at(-HOUR));
    await device("d-live", at(DAY));
    await key("k-signing", "signing", null);
    await key("k-recent", null, at(-HOUR));
    await key("k-old", null, at(-DAY - HOUR));
    await client("c-idle", at(-91 * DAY));
    await client("c-consent", at(-91 * DAY));
    await client("c-token", at(-91 * DAY));
    await client("c-new", at(-HOUR));
    await storage.create("oauthConsent", {
      id: "consent-1",
      userId: "u1",
      clientId: "c-consent",
      scopes: ["openid"],
      createdAt: now,
      updatedAt: now,
    });
    await refresh("r-expired", "c-new", at(-HOUR));
    await refresh("r-live", "c-token", at(DAY));
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
      pendingSessions: 0,
      apiTokens: 1,
      trustedDevices: 1,
      jwks: 1,
      oauthTokens: 1,
      oauthClients: 1,
      organizationTokens: 0,
      totpSetups: 0,
      limits: 1,
      oauthDevices: 0,
      oauthSessionLinks: 0,
      oauthLogouts: 0,
      oauthClientSecrets: 0,
      ssoDomains: 0,
      ssoPendingDomains: 0,
      scimTokens: 0,
      organizationRows: 0,
      anonymousUsers: 0,
    });

    const ids = (await storage.findMany("verification", [])).map((r) => r.id).sort();
    expect(ids).toEqual(["v-consumed-live", "v-pending"]);
    const invIds = (await storage.findMany("invitation", [])).map((r) => r.id);
    expect(invIds).toEqual(["i-pending"]);
    const sessionIds = (await storage.findMany("session", [])).map((r) => r.id);
    expect(sessionIds).toEqual(["s-live"]);
    const tokenIds = (await storage.findMany("apiToken", [])).map((r) => r.id).sort();
    expect(tokenIds).toEqual(["t-forever", "t-live"]);
    const deviceIds = (await storage.findMany("trustedDevice", [])).map((r) => r.id);
    expect(deviceIds).toEqual(["d-live"]);
    const keyIds = (await storage.findMany("jwk", [])).map((r) => r.id).sort();
    expect(keyIds).toEqual(["k-recent", "k-signing"]);
    const refreshIds = (await storage.findMany("oauthToken", [])).map((r) => r.id);
    expect(refreshIds).toEqual(["r-live"]);
    const clientIds = (await storage.findMany("oauthClient", [])).map((r) => r.id).sort();
    expect(clientIds).toEqual(["c-consent", "c-new", "c-token"]);

    expect(await sweepExpired(config)).toEqual({
      verificationExpired: 0,
      verificationConsumed: 0,
      invitations: 0,
      sessions: 0,
      pendingSessions: 0,
      apiTokens: 0,
      trustedDevices: 0,
      jwks: 0,
      oauthTokens: 0,
      oauthClients: 0,
      organizationTokens: 0,
      totpSetups: 0,
      limits: 0,
      oauthDevices: 0,
      oauthSessionLinks: 0,
      oauthLogouts: 0,
      oauthClientSecrets: 0,
      ssoDomains: 0,
      ssoPendingDomains: 0,
      scimTokens: 0,
      organizationRows: 0,
      anonymousUsers: 0,
    });
  });

  it("deletes an unconfirmed TOTP setup older than 15 minutes, and keeps a factor that is on and a fresh setup (plan 9f final fix wave)", async () => {
    const auth = totpAuth();
    const setup = async (email: string) => {
      const { user } = await verifiedSession(auth, email);
      const r = await setupTotp(auth.config, { userId: user.id, password: PASSWORD });
      if (!r.ok) throw new Error(r.code);
      return user.id;
    };
    const stale = await setup("old@example.com");
    const { user: on } = await enrolled(auth);
    auth.clock.advance(15 * MINUTE);
    const fresh = await setup("new@example.com");
    expect(await sweepExpired(auth.config)).toMatchObject({ totpSetups: 1 });
    const left = (await auth.storage.findMany("totp", [])).map((r) => r.userId).sort();
    expect(left).toEqual([on.id, fresh].sort());
    expect(left).not.toContain(stale);
    expect(await sweepExpired(auth.config)).toMatchObject({ totpSetups: 0 });
  });

  describe("the idle OAuth clients (plan 9g)", () => {
    it("deletes an idle client of the registration and keeps an idle client of api.oauth.clients (plan 12e)", async () => {
      const h = oauthHandle();
      const res = await h.auth.handle(
        post("/auth/oauth/register", { redirect_uris: ["https://client.example.com/cb"] }),
      );
      expect(res.status).toBe(201);
      const registeredId = ((await res.json()) as { client_id: string }).client_id;
      const made = await h.auth.api.oauth?.clients.create({
        redirectUris: ["https://client.example.com/cb"],
      });
      if (!made?.ok) throw new Error("create failed");
      const apiId = made.value.client.id;
      expect(made.value.client.kind).toBe("api");
      // 91 days with no authorize, no consent, and no refresh token.
      h.clock.advance(91 * DAY);
      expect(await h.auth.api.sweepExpired()).toMatchObject({ oauthClients: 1 });
      const left = (await h.storage.findMany("oauthClient", [])).map((c) => c.id);
      expect(left).toEqual([apiId]);
      expect(left).not.toContain(registeredId);
      // The kept client still works: findClient reads a cl_ id of kind api.
      expect(await findClient(h.config, apiId)).toMatchObject({ id: apiId, kind: "api" });
    });

    const idleClient = (storage: StorageAdapter, id: string, lastSeenAt: Date, now: Date) =>
      storage.create("oauthClient", {
        id,
        kind: "registered",
        name: null,
        redirectUris: ["https://client.example.com/cb"],
        lastSeenAt,
        createdAt: now,
        updatedAt: now,
        ...publicClientFields(),
      });

    it("moves a kept idle client out of the idle set, so the bounded read reaches a deletable client behind 100 kept ones (fix round 1)", async () => {
      const { config, storage, clock } = makeAuth();
      const now = clock.now();
      const idle = new Date(now.getTime() - 91 * DAY);
      // 101 kept clients come first in the read, then the one client the sweep may delete.
      const kept = Array.from({ length: 101 }, (_, i) => `c-${String(i).padStart(3, "0")}`);
      for (const id of kept) {
        await idleClient(storage, id, idle, now);
        await storage.create("oauthConsent", {
          id: `consent-${id}`,
          userId: "u1",
          clientId: id,
          scopes: ["openid"],
          createdAt: now,
          updatedAt: now,
        });
      }
      await idleClient(storage, "c-zzz", idle, now);

      // Each sweep reaches the clients that its call budget allows (ruling 37 of plan 12f).
      const counts: number[] = [];
      while (counts.length < 40 && !counts.includes(1))
        counts.push((await sweepExpired(config)).oauthClients);
      // 102 idle clients, 4 of them in each sweep: the deletable one goes in sweep 26. The
      // single-statement steps run before the client step, so it gets fewer calls (review m1).
      // Plan 12k adds one such step, the delete of the organization tokens: 5 became 4.
      expect([counts.length, counts.reduce((a, b) => a + b, 0)]).toEqual([26, 1]);
      const left = await storage.findMany("oauthClient", []);
      expect(left.map((r) => r.id).sort()).toEqual(kept);
      // A kept client counts as seen by the sweep.
      expect(left.every((r) => r.lastSeenAt.getTime() === now.getTime())).toBe(true);
    });

    it("keeps a client that an authorize saw between the read and the delete (fix round 1)", async () => {
      const { config, storage, clock } = makeAuth();
      const now = clock.now();
      await idleClient(storage, "c-seen", new Date(now.getTime() - 91 * DAY), now);
      // The authorize runs while the sweep reads the refresh tokens of the client.
      const racing: StorageAdapter = {
        ...storage,
        findOne: async (model, where, ...rest) => {
          if (model === "oauthToken" && where.some((w) => w.value === "c-seen")) {
            await storage.update("oauthClient", [{ field: "id", op: "eq", value: "c-seen" }], {
              lastSeenAt: now,
            });
          }
          return storage.findOne(model, where, ...rest);
        },
      };
      expect(await sweepExpired({ ...config, storage: racing })).toMatchObject({
        oauthClients: 0,
      });
      expect(
        await storage.findOne("oauthClient", [{ field: "id", op: "eq", value: "c-seen" }]),
      ).toMatchObject({ lastSeenAt: now });
    });
  });

  it("the README's Sweep section has one bullet per count that sweepExpired answers, and no other (plan 9h)", async () => {
    const { readFileSync }: ReadmeFs = await import(/* @vite-ignore */ FS_MODULE);
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const start = readme.indexOf("\n## Sweep\n");
    const end = readme.indexOf("\n## ", start + 1);
    expect(start).toBeGreaterThan(-1);
    const section = readme.slice(start, end);
    const listed = [...section.matchAll(/^- `([A-Za-z]+)`: /gm)].map((m) => m[1]).sort();
    const counts = Object.keys(await sweepExpired(makeAuth().config)).sort();
    expect(listed).toEqual(counts);
    // The README is not a record: the dated paragraphs of plans 8b to 9g are folded into the list.
    expect(section).not.toMatch(/five counts|a sixth count|Since plan/);
  });
});
