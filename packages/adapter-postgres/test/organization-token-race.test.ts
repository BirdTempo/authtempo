import { createAuth, type StorageAdapter } from "@authtempo/core";
import { createOrganizationTokenAs } from "@authtempo/core/compat";
import postgres, { type Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase, PG_URL } from "./db.js";

// The cap of plan 12k Task 8 on the real Postgres adapter, through core's
// built output. Each instance has its own client of one connection, so the
// two creates run as two requests on two connections do.

const t0 = new Date("2026-01-01T00:00:00.000Z");
const CAP = 50;

let db: Awaited<ReturnType<typeof freshDatabase>>;
let clients: Sql[] = [];
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
  clients = [];
  await db.close();
});

/** A client of one connection on the schema of `db`. */
async function connection(): Promise<Sql> {
  const [row] = await db.sql<{ schema: string }[]>`select current_schema() as schema`;
  const sql = postgres(PG_URL, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: row?.schema ?? "" },
  });
  clients.push(sql);
  return sql;
}

/**
 * A storage, and the storage of each of its transactions, that calls
 * `reached` when the create reaches its lock of the organization row or its
 * count returns, and then waits for `other` before it writes the token. So
 * without the lock both counts run before either create, and with the lock
 * the second count waits for the first commit. No pause runs.
 */
function gated(base: StorageAdapter, reached: () => void, other: Promise<void>): StorageAdapter {
  return {
    ...base,
    async update(model, where, data) {
      if (model === "organization") reached();
      return base.update(model, where, data);
    },
    async findMany(model, where, options) {
      const rows = await base.findMany(model, where, options);
      if (model === "organizationToken") {
        reached();
        await other;
      }
      return rows;
    },
    transaction: (fn) => base.transaction((tx) => fn(gated(tx, reached, other))),
  };
}

function instance(storage: StorageAdapter) {
  return createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async () => {} },
    clock: { now: () => t0 },
    organizations: {},
  });
}

describe("the organization token cap on Postgres (plan 12k Task 8)", () => {
  it("makes one token of two creates at 49 live rows", async () => {
    let reachedA = () => {};
    let reachedB = () => {};
    const aReached = new Promise<void>((r) => {
      reachedA = r;
    });
    const bReached = new Promise<void>((r) => {
      reachedB = r;
    });
    const a = instance(gated(createPostgresAdapter(await connection()), reachedA, bReached));
    const b = instance(gated(createPostgresAdapter(await connection()), reachedB, aReached));
    const storage = createPostgresAdapter(db.sql);
    // The setup instance has no gate, so neither gate sees the setup.
    const plain = instance(storage);
    const user = await storage.create("user", {
      id: "u1",
      email: "u1@example.com",
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: t0,
      updatedAt: t0,
    });
    const org = await plain.api.createOrganization({ user, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    const input = {
      user,
      organizationId: org.value.organization.id,
      name: "ci",
      permissions: {},
    };
    for (let i = 0; i < CAP - 1; i++) {
      // A user with no sign-in: the compat seam, with the user row's rule (plan 12p).
      const made = await createOrganizationTokenAs(plain, input);
      if (!made.ok) throw new Error(made.code);
    }
    const answers = await Promise.all([
      createOrganizationTokenAs(a, input),
      createOrganizationTokenAs(b, input),
    ]);
    const codes = answers.map((r) => (r.ok ? "ok" : r.code)).sort();
    expect(codes).toEqual(["ok", "organization_token_limit"]);
    expect(await storage.findMany("organizationToken", [])).toHaveLength(CAP);
  });
});

/** A promise and the call that resolves it. */
function signal() {
  let fire = () => {};
  const promise = new Promise<void>((r) => {
    fire = r;
  });
  return { promise, fire };
}

/**
 * A storage, and the storage of each of its transactions, that runs `before`
 * ahead of each write of `model` (an update or a create). The setup and the
 * other flow use other instances, so the hook sees one flow only.
 */
function held(
  base: StorageAdapter,
  model: "organization" | "organizationToken",
  before: () => Promise<void>,
): StorageAdapter {
  return {
    ...base,
    async update(m, where, data) {
      if (m === model) await before();
      return base.update(m, where, data);
    },
    async create(m, row) {
      if (m === model) await before();
      return base.create(m, row);
    },
    transaction: (fn) => base.transaction((tx) => fn(held(tx, model, before))),
  };
}

let next = 0;
/** A verified user row, as a sign-up with a verified address leaves it. */
async function user(storage: StorageAdapter) {
  next += 1;
  return storage.create("user", {
    id: `u${next}`,
    email: `u${next}@example.com`,
    emailVerified: true,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    username: null,
    displayUsername: null,
    phone: null,
    isAnonymous: false,
    createdAt: t0,
    updatedAt: t0,
  });
}

/** An organization of a new owner with a new admin, made by the real flows. */
async function adminOf(storage: StorageAdapter) {
  const plain = instance(storage);
  const owner = await user(storage);
  const admin = await user(storage);
  const org = await plain.api.createOrganization({
    user: owner,
    slug: `acme-${next}`,
    name: "Acme",
  });
  if (!org.ok) throw new Error(org.code);
  const organizationId = org.value.organization.id;
  const added = await plain.api.addMember({
    user: owner,
    organizationId,
    userId: admin.id,
    role: "admin",
  });
  if (!added.ok) throw new Error(added.code);
  return { owner, admin, organizationId };
}

/** The live tokens of the organization whose creator has no member row there. */
async function orphans(storage: StorageAdapter, organizationId: string) {
  const tokens = await storage.findMany("organizationToken", [
    { field: "organizationId", op: "eq", value: organizationId },
  ]);
  const members = await storage.findMany("member", [
    { field: "organizationId", op: "eq", value: organizationId },
  ]);
  const present = new Set(members.map((m) => m.userId));
  return tokens.filter((t) => !present.has(t.createdById));
}

// Ruling 32 of plan 12k: a create of the admin and the removal of the admin
// with revokeTokens, on two connections. Each order runs five times.
describe("an organization token create against a removal with revokeTokens on Postgres (ruling 32)", () => {
  it("refuses the create when the removal commits between its standing read and its lock", async () => {
    const storage = createPostgresAdapter(db.sql);
    const first = createPostgresAdapter(await connection());
    const b = instance(createPostgresAdapter(await connection()));
    for (let i = 0; i < 5; i++) {
      const { owner, admin, organizationId } = await adminOf(storage);
      const removed = signal();
      // The create waits at its lock until the removal has committed.
      const a = instance(held(first, "organization", () => removed.promise));
      const create = createOrganizationTokenAs(a, {
        user: admin,
        organizationId,
        name: "ci",
        permissions: {},
      });
      const removal = await b.api.removeMember({
        user: owner,
        organizationId,
        userId: admin.id,
        revokeTokens: true,
      });
      removed.fire();
      const made = await create;
      expect(removal.ok).toBe(true);
      expect(made.ok ? "ok" : made.code).toBe("forbidden_rank");
      expect(await orphans(storage, organizationId)).toEqual([]);
    }
  });

  it("revokes the token when the create holds the lock as the removal starts", async () => {
    const storage = createPostgresAdapter(db.sql);
    const first = createPostgresAdapter(await connection());
    const second = createPostgresAdapter(await connection());
    for (let i = 0; i < 5; i++) {
      const { owner, admin, organizationId } = await adminOf(storage);
      const atInsert = signal();
      const atLock = signal();
      const removed = signal();
      // The create holds the lock and waits before its insert, until the removal reaches
      // its own lock or ends. Without that lock the removal ends first, and the insert comes later.
      const a = instance(
        held(first, "organizationToken", async () => {
          atInsert.fire();
          await Promise.race([atLock.promise, removed.promise]);
        }),
      );
      const b = instance(held(second, "organization", async () => atLock.fire()));
      const create = createOrganizationTokenAs(a, {
        user: admin,
        organizationId,
        name: "ci",
        permissions: {},
      });
      await atInsert.promise;
      const removal = b.api
        .removeMember({ user: owner, organizationId, userId: admin.id, revokeTokens: true })
        .finally(() => removed.fire());
      const [made, gone] = await Promise.all([create, removal]);
      expect(made.ok ? "ok" : made.code).toBe("ok");
      expect(gone.ok).toBe(true);
      expect(await orphans(storage, organizationId)).toEqual([]);
    }
  });
});
