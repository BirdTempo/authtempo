import { describe, expect, it } from "vitest";
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
