import { describe, expect, it } from "vitest";
import type { VerificationRow } from "../src/schema.js";
import type { Where } from "../src/storage/port.js";
import { d1Like } from "./d1-like.js";
import { makeAuth } from "./helpers.js";

const t1 = new Date("2026-01-01T00:00:01.000Z");
const t2 = new Date("2026-01-01T00:00:02.000Z");
const byId = (id: string) => [{ field: "id" as const, op: "eq" as const, value: id }];

// The test view must keep the D1 adapter's undo rule (ruling 47 of plan
// 12k). Otherwise a core test on it answers what real D1 never answers.
describe("the D1-like view's undo of an update", () => {
  it("restores each field on its own and keeps a field that another request moved", async () => {
    const { config, storage, seedUser } = makeAuth();
    const user = await seedUser("ada@example.com");
    const view = d1Like(config).storage;
    await expect(
      view.transaction(async (tx) => {
        await tx.update("user", byId(user.id), { name: "X", updatedAt: t1 });
        // Another request, outside this transaction: a profile write of the image.
        await storage.update("user", byId(user.id), {
          image: "https://i.example.com/a.png",
          updatedAt: t2,
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await storage.findOne("user", byId(user.id))).toMatchObject({
      name: null,
      image: "https://i.example.com/a.png",
      updatedAt: new Date("2026-01-01T00:00:02.000Z"),
    });
  });

  it("keeps a later write over a field that the update wrote with its own value", async () => {
    const { config, storage, seedUser } = makeAuth();
    const user = await seedUser("ada@example.com");
    const view = d1Like(config).storage;
    await expect(
      view.transaction(async (tx) => {
        // The user hold: updatedAt back to its own value.
        await tx.update("user", byId(user.id), { updatedAt: user.updatedAt });
        await storage.update("user", byId(user.id), { name: "Ada", updatedAt: t1 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await storage.findOne("user", byId(user.id))).toMatchObject({
      name: "Ada",
      updatedAt: new Date("2026-01-01T00:00:01.000Z"),
    });
  });
});

// The view keeps the D1 adapter's rule of `undoOnlyWhile` with a second
// condition (ruling 36 of plan 12q). A claim passes its own lease there.
describe("the D1-like view's undo of a delete under two conditions", () => {
  it("puts the row back only while each condition reads a row at the undo", async () => {
    const { config, storage, seedUser } = makeAuth();
    const user = await seedUser("ada@example.com");
    const view = d1Like(config).storage;
    const row = (id: string): VerificationRow => ({
      id,
      purpose: "magic-link",
      identifier: "ada@example.com",
      valueHash: `hash-${id}`,
      expiresAt: t2,
      consumedAt: null,
      data: null,
      createdAt: t1,
      updatedAt: t1,
      secretVersion: 1,
    });
    await storage.create("verification", row("lease"));
    await storage.create("verification", row("v1"));
    const lease: Where<"verification">[] = [
      ...byId("lease"),
      { field: "expiresAt", op: "eq", value: t2 },
    ];
    // Another request runs `rival` while the transaction is open, then it throws.
    const thrown = (rival: () => Promise<unknown>) =>
      expect(
        view.transaction(async (tx) => {
          await tx.undoOnlyWhile?.("user", byId(user.id), { model: "verification", where: lease });
          await tx.delete("verification", byId("v1"));
          await rival();
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    await thrown(async () => {});
    expect(await storage.findOne("verification", byId("v1"))).not.toBeNull();
    // A rival's take of the lease writes a new expiry, so the row stays gone.
    await thrown(() => storage.update("verification", byId("lease"), { expiresAt: t1 }));
    expect(await storage.findOne("verification", byId("v1"))).toBeNull();
  });
});
