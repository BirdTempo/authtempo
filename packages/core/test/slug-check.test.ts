import { describe, expect, it, vi } from "vitest";
import { createSession } from "../src/engine/sessions.js";
import { createApiToken } from "../src/engine/tokens.js";
import { createRouter } from "../src/http/router.js";
import { organizationRoutes } from "../src/http/routes/organizations.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth, platformAuth, post, seedPlatform } from "./helpers.js";

const CHECK = "/auth/organizations/check-slug";

function setup(auth: ReturnType<typeof makeAuth> = makeAuth({ organizations: {} })) {
  const handle = createRouter(auth.config, organizationRoutes(auth.config));
  async function cookieFor(user: UserRow) {
    const { token } = await createSession(auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    return { cookie: `${auth.config.cookieName}=${token}` };
  }
  async function check(h: Record<string, string>, slug: unknown) {
    const res = await handle(post(CHECK, { slug }, h));
    return { status: res.status, body: (await res.json()) as unknown };
  }
  return { auth, handle, cookieFor, check };
}

type Read = (model: string, where: { field: string }[], ...rest: unknown[]) => Promise<unknown>;

/** Records each organization read by slug on `storage`, outside and inside a transaction. */
function slugReads(storage: StorageAdapter): string[] {
  const seen: string[] = [];
  const watch = (st: StorageAdapter): StorageAdapter => {
    const methods = st as unknown as Record<"findOne" | "findMany", Read>;
    for (const name of ["findOne", "findMany"] as const) {
      const real = methods[name].bind(st);
      methods[name] = (model, where, ...rest) => {
        if (model === "organization" && where.some((w) => w.field === "slug")) seen.push(name);
        return real(model, where, ...rest);
      };
    }
    return st;
  };
  watch(storage);
  const transaction = storage.transaction.bind(storage);
  storage.transaction = ((fn: (tx: StorageAdapter) => Promise<unknown>) =>
    transaction((tx) => fn(watch(tx)))) as StorageAdapter["transaction"];
  return seen;
}

describe("the slug check (plan 12k Task 6)", () => {
  it("answers each of the four statuses", async () => {
    const s = setup(platformAuth());
    await seedPlatform(s.auth);
    const ada = await s.auth.seedUser("ada@example.com");
    const h = await s.cookieFor(ada);
    const created = await s.handle(
      post("/auth/organizations/create", { slug: "acme", name: "Acme" }, h),
    );
    expect(created.status).toBe(200);
    // A fullwidth form folds to its ASCII slug, and that slug is in use.
    expect(await s.check(h, "ＡＣＭＥ")).toEqual({
      status: 200,
      body: { slug: "acme", status: "taken" },
    });
    expect(await s.check(h, "Beta-Co")).toEqual({
      status: 200,
      body: { slug: "beta-co", status: "available" },
    });
    // A name of the reserved list, in a fullwidth form.
    expect(await s.check(h, "ＡＤＭＩＮ")).toEqual({
      status: 200,
      body: { slug: "admin", status: "reserved" },
    });
    // The platform organization exists, and its slug answers reserved, not taken.
    expect(await s.check(h, "Platform-Co")).toEqual({
      status: 200,
      body: { slug: "platform-co", status: "reserved" },
    });
    expect(await s.check(h, "My Org")).toEqual({
      status: 200,
      body: { slug: null, status: "invalid" },
    });
    expect(await s.check(h, "-acme")).toEqual({
      status: 200,
      body: { slug: null, status: "invalid" },
    });
    // The body bounds the length before the fold: 65 units answer invalid_body.
    expect(await s.check(h, "a".repeat(65))).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
    expect(await s.check(h, "")).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await s.check(h, 7)).toEqual({ status: 400, body: { error: "invalid_body" } });
    // The body is strict: another key answers invalid_body.
    const extra = await s.handle(post(CHECK, { slug: "acme", extra: 1 }, h));
    expect({ status: extra.status, body: await extra.json() }).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
    // The check writes no organization: the two organizations stay, and no organization row is new.
    const slugs = (await s.auth.storage.findMany("organization", [])).map((o) => o.slug).sort();
    expect(slugs).toEqual(["acme", "platform-co"]);
  });

  it("limits each user to 60 per minute", async () => {
    const s = setup();
    const ada = await s.auth.seedUser("ada@example.com");
    const bob = await s.auth.seedUser("bob@example.com");
    const h = await s.cookieFor(ada);
    for (let i = 0; i < 60; i++) {
      const r = await s.check(h, `name-${i}`);
      expect(r.status, `call ${i + 1}`).toBe(200);
    }
    // The limiter runs before any read of an organization row. A spy calls the real read.
    const findOne = vi.spyOn(s.auth.storage, "findOne");
    const findMany = vi.spyOn(s.auth.storage, "findMany");
    const models = () => [...findOne.mock.calls, ...findMany.mock.calls].map(([model]) => model);
    // The key is per user: another user still checks, and the spy sees that read.
    const hb = await s.cookieFor(bob);
    findOne.mockClear();
    findMany.mockClear();
    expect((await s.check(hb, "name-60")).status).toBe(200);
    expect(models()).toContain("organization");
    findOne.mockClear();
    findMany.mockClear();
    expect(await s.check(h, "name-60")).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    expect(models()).not.toContain("organization");
    findOne.mockRestore();
    findMany.mockRestore();
    // The window is one minute.
    s.auth.clock.advance(60_000);
    expect(await s.check(h, "name-60")).toEqual({
      status: 200,
      body: { slug: "name-60", status: "available" },
    });
  });

  it("holds the check, the create, and the rename to one bound of 60 per user per minute", async () => {
    const s = setup();
    const ada = await s.auth.seedUser("ada@example.com");
    const bob = await s.auth.seedUser("bob@example.com");
    const h = await s.cookieFor(ada);
    const create = async (headers: Record<string, string>, slug: string) => {
      const res = await s.handle(
        post("/auth/organizations/create", { slug, name: "Org" }, headers),
      );
      return { status: res.status, body: (await res.json()) as unknown };
    };
    const rename = async (organizationId: string, slug: string) => {
      const res = await s.handle(post("/auth/organizations/update", { organizationId, slug }, h));
      return { status: res.status, body: (await res.json()) as unknown };
    };
    const made = await create(h, "acme");
    expect(made.status).toBe(200);
    const organizationId = (made.body as { organization: { id: string } }).organization.id;
    // A new window: 59 checks and one rename spend the 60 of this minute.
    s.auth.clock.advance(60_000);
    for (let i = 0; i < 59; i++) {
      expect((await s.check(h, `name-${i}`)).status, `check ${i + 1}`).toBe(200);
    }
    expect((await rename(organizationId, "acme-2")).status).toBe(200);
    // The 61st slug read answers rate_limited before the read, at the create and at the rename.
    const seen = slugReads(s.auth.storage);
    expect(await create(h, "beta")).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(await rename(organizationId, "acme-3")).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    expect(seen).toEqual([]);
    // The key is per user: another user still creates, and the watch sees that read.
    expect((await create(await s.cookieFor(bob), "beta")).status).toBe(200);
    expect(seen.length).toBeGreaterThan(0);
    // The window is one minute.
    s.auth.clock.advance(60_000);
    expect((await create(h, "gamma")).status).toBe(200);
    expect((await rename(organizationId, "acme-3")).status).toBe(200);
    const slugs = (await s.auth.storage.findMany("organization", [])).map((o) => o.slug).sort();
    expect(slugs).toEqual(["acme-3", "beta", "gamma"]);
  });

  it("needs a verified address", async () => {
    const s = setup();
    const seeded = await s.auth.seedUser("seed@example.com");
    const unverified = await s.auth.storage.create("user", {
      ...seeded,
      id: "u-unverified",
      email: "unverified@example.com",
      emailVerified: false,
    });
    expect(await s.check(await s.cookieFor(unverified), "acme")).toEqual({
      status: 403,
      body: { error: "email_unverified" },
    });
  });

  it("takes a session only", async () => {
    const s = setup();
    const ada = await s.auth.seedUser("ada@example.com");
    const made = await createApiToken(s.auth.config, { user: ada, name: "ci" });
    if (!made.ok) throw new Error(made.code);
    expect(made.value.token.startsWith("tk_")).toBe(true);
    expect(await s.check({ authorization: `Bearer ${made.value.token}` }, "acme")).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(await s.check({}, "acme")).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("a slug that answered available can still answer slug_taken at create", async () => {
    const s = setup();
    const ada = await s.auth.seedUser("ada@example.com");
    const bob = await s.auth.seedUser("bob@example.com");
    const ha = await s.cookieFor(ada);
    const hb = await s.cookieFor(bob);
    expect(await s.check(ha, "acme")).toEqual({
      status: 200,
      body: { slug: "acme", status: "available" },
    });
    // The answer holds nothing: another user takes the slug between the check and the create.
    const taken = await s.handle(
      post("/auth/organizations/create", { slug: "acme", name: "Bob's" }, hb),
    );
    expect(taken.status).toBe(200);
    const late = await s.handle(
      post("/auth/organizations/create", { slug: "acme", name: "Ada's" }, ha),
    );
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "slug_taken" });
    expect(await s.check(ha, "acme")).toEqual({
      status: 200,
      body: { slug: "acme", status: "taken" },
    });
  });
});
