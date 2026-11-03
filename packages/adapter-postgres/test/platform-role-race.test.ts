import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// Two grants of the platform role at the member limit, on the real Postgres
// adapter, through core's built output (decision 15 of plan 12n). Each
// instance's transaction takes its own connection of the pool, so the two
// grants run as two requests on two connections do. The memory adapter runs
// one transaction at a time, so only Postgres shows this order.

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
/** Every request passes: the race, not the limit of the requests, is under test. */
const OPEN = { allow: async () => true };
const APP = { kind: "app", name: "support-tool" } as const;
const REASON = { reason: "Change of the support team", ip: null, userAgent: null };

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/**
 * A storage on the shared pool whose transactions call `locking` before each
 * organization update: the lock of the member count.
 */
function lockWatch(locking: () => void): StorageAdapter {
  const base = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    update(model, where, data) {
      if (model === "organization") locking();
      return tx.update(model, where, data);
    },
    transaction: (fn) => tx.transaction((inner) => fn(wrap(inner))),
  });
  return { ...base, transaction: (fn) => base.transaction((tx) => fn(wrap(tx))) };
}

/** One instance of core on `storage`, with the member limit `limit` and `hold` as the member hook. */
function instance(
  storage: StorageAdapter,
  sent: MailMessage[],
  limit: number | null,
  hold?: () => Promise<void>,
) {
  return createAuth({
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [],
    storage,
    limiter: OPEN,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      ...(limit === null ? {} : { limits: { membersPerOrganization: limit } }),
    },
    operator: { users: true },
    ...(hold ? { hooks: { organization: { beforeAddMember: hold } } } : {}),
  });
}

/** A verified user through a magic link sign-in: the user id. */
async function signIn(
  auth: ReturnType<typeof instance>,
  sent: MailMessage[],
  email: string,
): Promise<string> {
  await auth.api.requestMagicLink({ email, ip: null });
  const m = [...sent].reverse().find((x) => x.to === email);
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok) throw new Error(r.code);
  return r.value.user.id;
}

/** The count of the member rows of the platform organization. */
async function members(): Promise<number> {
  const rows = await db.sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM ta_member m
    JOIN ta_organization o ON o.id = m.organization_id
    WHERE o.slug = 'platform-co'`;
  return rows[0]?.n ?? 0;
}

describe("the grant of the platform role at the member limit on Postgres (decision 15 of plan 12n)", () => {
  it("of two grants to two users at the limit, one answers ok and one member_limit, a delay sweep", async () => {
    const sent: MailMessage[] = [];
    const setup = instance(createPostgresAdapter(db.sql), sent, null);
    const made = await setup.api.operator.createAdmin({
      actor: APP,
      email: "op@example.com",
      reason: "First operator",
      ip: null,
      userAgent: null,
    });
    if (!made.ok) throw new Error(made.code);
    for (let round = 0; round < 8; round++) {
      const a = await signIn(setup, sent, `a-${round}@example.com`);
      const b = await signIn(setup, sent, `b-${round}@example.com`);
      const held = await members();
      // The second grant starts 0 to 7 ms into the member hook of the first,
      // after the first counted. The hook returns when the second reaches its
      // lock of the count, or when the second ends. With no lock, the second
      // counts the same rows as the first, and both rows commit.
      let second: Promise<{ ok: boolean }> | null = null;
      let reached = () => {};
      const atLock = new Promise<void>((r) => {
        reached = r;
      });
      const hold = async () => {
        if (second) return;
        second = (async () => {
          await new Promise((r) => setTimeout(r, round));
          return two.api.operator.platformRole.grant({ actor: APP, userId: b, ...REASON });
        })();
        await Promise.race([atLock, second]);
      };
      const one = instance(createPostgresAdapter(db.sql), sent, held + 1, hold);
      const two = instance(
        lockWatch(() => reached()),
        sent,
        held + 1,
        hold,
      );
      const first = await one.api.operator.platformRole.grant({
        actor: APP,
        userId: a,
        ...REASON,
      });
      expect(first.ok).toBe(true);
      expect(second).not.toBeNull();
      expect(await second).toEqual({ ok: false, code: "member_limit", status: 409 });
      expect(await members()).toBe(held + 1);
    }
  }, 60_000);
});
