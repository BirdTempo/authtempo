import { createAuth, type MailMessage, type Statements, type UserRow } from "@authtempo/core";
import type { Pool } from "mysql2/promise";
import { afterEach, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_84, type MysqlDatabase } from "./db.js";

// The port of adapter-postgres/test/accept-one-connection.test.ts to MySQL
// 8.4 (ruling 1 of plan 12g). An accept reads the role rows of a dynamic role inside its transaction
// (plan 12k Task 4, ruling 24 M2). Each read there must go through the
// transaction handle. A read through the outer client waits for the one
// connection that the transaction holds, so the accept never ends. The timer
// turns such a hang into a failed assertion, not a test timeout.

/** Below the 15-second test timeout, and far above one accept on a local MySQL. */
const WAIT_MS = 8_000;

let db: MysqlDatabase | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

/** core on `pool` with dynamic roles on, and the users ada (who owns acme), bob, and dave. */
async function world(pool: Pool) {
  const sent: MailMessage[] = [];
  const storage = createMysqlAdapter(pool);
  const auth = createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: ["https://app.example.com"],
    storage,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    organizations: { dynamicRoles: {} },
  });
  const now = new Date();
  const user = (id: string, email: string) =>
    storage.create("user", {
      id,
      email,
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
      createdAt: now,
      updatedAt: now,
    });
  const ada = await user("01JAAAAAAAAAAAAAAAAAAAAAAA", "ada@example.com");
  const bob = await user("01JBBBBBBBBBBBBBBBBBBBBBBB", "bob@example.com");
  const dave = await user("01JDDDDDDDDDDDDDDDDDDDDDDD", "dave@example.com");
  const org = await auth.api.createOrganization({ user: ada, slug: "acme", name: "Acme" });
  if (!org.ok) throw new Error(org.code);
  const organizationId = org.value.organization.id;
  const must = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const role = async (name: string, rank: number, permissions: Statements) =>
    must(await auth.api.createRole({ user: ada, organizationId, name, rank, permissions }));
  /** An invite of `role` by `by` and its accept by dave: "done", "failed <code>", "threw", or "timeout". */
  async function acceptOf(by: UserRow, role: string): Promise<string> {
    must(
      await auth.api.inviteMember({ user: by, organizationId, email: "dave@example.com", role }),
    );
    const token = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
    // The second handler keeps a rejection handled: `close` ends the pool under a hung accept.
    const accept = auth.api.acceptInvitation({ user: dave, token, ip: null }).then(
      (r) => (r.ok ? "done" : `failed ${r.code}`),
      () => "threw",
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), WAIT_MS);
    });
    try {
      return await Promise.race([accept, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  return { auth, storage, ada, bob, dave, organizationId, must, role, acceptOf };
}

const roleOf = async (w: Awaited<ReturnType<typeof world>>, userId: string) =>
  (await w.storage.findOne("member", [{ field: "userId", op: "eq", value: userId }]))?.role;

it("accepts an invitation of a dynamic role on a pool of one", async () => {
  db = await freshDatabase(MYSQL_84, { connectionLimit: 1 });
  const w = await world(db.pool);
  await w.role("editor", 2, { member: ["read"] });
  expect(await w.acceptOf(w.ada, "editor")).toBe("done");
  expect(await roleOf(w, w.dave.id)).toBe("editor");
});

it("accepts an invitation of a static and a dynamic part on a pool of one", async () => {
  db = await freshDatabase(MYSQL_84, { connectionLimit: 1 });
  const w = await world(db.pool);
  await w.role("editor", 2, { member: ["read"] });
  expect(await w.acceptOf(w.ada, "viewer,editor")).toBe("done");
  expect(await roleOf(w, w.dave.id)).toBe("viewer,editor");
});

it("raises a member of a dynamic role by an inviter of a dynamic role on a pool of one", async () => {
  db = await freshDatabase(MYSQL_84, { connectionLimit: 1 });
  const w = await world(db.pool);
  // Each of the three reads of the accept names a dynamic part: the inviter, the grant, and the current role.
  await w.role("lead", 3, { member: ["read"], invitation: ["read", "create"] });
  await w.role("editor", 2, { member: ["read"] });
  await w.role("helper", 1, { member: ["read"] });
  const add = (userId: string, role: string) =>
    w.auth.api.addMember({ user: w.ada, organizationId: w.organizationId, userId, role });
  w.must(await add(w.bob.id, "lead"));
  w.must(await add(w.dave.id, "helper"));
  expect(await w.acceptOf(w.bob, "editor")).toBe("done");
  expect(await roleOf(w, w.dave.id)).toBe("editor");
});
