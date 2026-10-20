import { createAuth, type MailMessage } from "@authtempo/core";
import type { Sql } from "postgres";
import { afterEach, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabaseOf } from "./db.js";

// An accept reads the role rows of a dynamic role inside its transaction
// (plan 12k Task 4, ruling 24 M2). Each read there must go through the
// transaction handle. A read through the outer client waits for the one
// connection that the transaction holds, so the accept never ends. The timer
// turns such a hang into a failed assertion, not a test timeout.

/** Far below the 15-second test timeout, and far above one accept on a local Postgres. */
const WAIT_MS = 8_000;

let db: Awaited<ReturnType<typeof freshDatabaseOf>> | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

/** An invite of `role` and its accept by dave: "done", "failed <code>", "threw", or "timeout" after `waitMs`. */
async function acceptOf(sql: Sql, role: string, waitMs: number): Promise<string> {
  const sent: MailMessage[] = [];
  const storage = createPostgresAdapter(sql);
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
      createdAt: now,
      updatedAt: now,
    });
  const ada = await user("01JAAAAAAAAAAAAAAAAAAAAAAA", "ada@example.com");
  const dave = await user("01JBBBBBBBBBBBBBBBBBBBBBBB", "dave@example.com");
  const org = await auth.api.createOrganization({ user: ada, slug: "acme", name: "Acme" });
  if (!org.ok) throw new Error(org.code);
  const organizationId = org.value.organization.id;
  const made = await auth.api.createRole({
    user: ada,
    organizationId,
    name: "editor",
    rank: 2,
    permissions: { member: ["read"] },
  });
  if (!made.ok) throw new Error(made.code);
  const inv = await auth.api.inviteMember({
    user: ada,
    organizationId,
    email: "dave@example.com",
    role,
  });
  if (!inv.ok) throw new Error(inv.code);
  const token = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
  // The second handler keeps a rejection handled: `close` ends the client under a hung accept.
  const accept = auth.api.acceptInvitation({ user: dave, token, ip: null }).then(
    (r) => (r.ok ? "done" : `failed ${r.code}`),
    () => "threw",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
  });
  try {
    return await Promise.race([accept, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

it("accepts an invitation of a dynamic role on a pool of one", async () => {
  db = await freshDatabaseOf(1);
  expect(await acceptOf(db.sql, "editor", WAIT_MS)).toBe("done");
  const members = await createPostgresAdapter(db.sql).findMany("member", []);
  expect(members.map((m) => m.role).sort()).toEqual(["editor", "owner"]);
});

it("accepts an invitation of a static and a dynamic part on a pool of one", async () => {
  db = await freshDatabaseOf(1);
  expect(await acceptOf(db.sql, "viewer,editor", WAIT_MS)).toBe("done");
});
