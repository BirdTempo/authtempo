import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { appActor, type OperatorActor } from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { makeAuth, post, settled } from "./helpers.js";
import { OPERATOR_SECRETS, operatorAuth, secretActor } from "./operator-helpers.js";

// The operator create (plan 12f2 Task 2, spec 26). Every user here comes from
// the create itself; no test writes a user row by storage.

const ADA = "ada@example.com";
const PHONE = "+15555550100";
const REASON = { reason: "Ticket 4521", ip: "203.0.113.9", userAgent: "Support/1" };

afterEach(() => {
  vi.restoreAllMocks();
});

function appOf(name: string): OperatorActor {
  const actor = appActor(name);
  if (!actor.ok) throw new Error(actor.code);
  return actor.value;
}

/**
 * The engine view of plan 12f (`operatorAuth`: password, the platform
 * organization, and the secrets `support` with `users` and `keys` with no
 * `users`), and the phone of plan 12i on the memory limiter with the region
 * `+1`. The hooks record each user hook with its via.
 */
async function world(extra: Partial<AuthConfig> = {}) {
  const sms = createRecordingSms();
  const hooks: string[] = [];
  const auth = await operatorAuth({
    phone: { sms, regions: ["+1"], isolateLimiter: "allow" },
    hooks: {
      user: {
        beforeCreate: ({ via }) => void hooks.push(`beforeCreate:${via}`),
        afterCreate: ({ via }) => void hooks.push(`afterCreate:${via}`),
      },
    },
    ...extra,
  });
  return {
    ...auth,
    sms,
    hooks,
    api: operatorApi(auth.config).users,
    desk: appOf("support-desk"),
  };
}
/**
 * The user tools with no password, and with no phone unless `phone`. The
 * tools need a secret with `users`; the tests act as the app.
 */
async function bare(phone: boolean) {
  const sms = createRecordingSms();
  const auth = makeAuth({
    operator: {
      users: true,
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(OPERATOR_SECRETS.support),
          scopes: ["users"],
        },
      ],
    },
    ...(phone ? { phone: { sms, regions: ["+1"], isolateLimiter: "allow" as const } } : {}),
  });
  return { ...auth, api: operatorApi(auth.config).users, desk: appOf("support-desk") };
}

const users = (w: { storage: StorageAdapter }) => w.storage.findMany("user", []);
const auditRows = (w: { storage: StorageAdapter }) =>
  w.storage.findMany("operatorAudit", [{ field: "action", op: "eq", value: "user_create" }]);

/** Each storage call on `storage` from now on, as `[method, model]`. */
function spyStorage(storage: StorageAdapter): [string, unknown][] {
  const calls: [string, unknown][] = [];
  for (const name of [
    "create",
    "createMany",
    "findOne",
    "findMany",
    "update",
    "delete",
    "transaction",
  ] as const) {
    const real = storage[name].bind(storage) as (...a: unknown[]) => unknown;
    vi.spyOn(storage, name).mockImplementation(((...args: unknown[]) => {
      calls.push([name, args[0]]);
      return real(...args);
    }) as never);
  }
  return calls;
}

describe("the operator create (plan 12f2 Task 2)", () => {
  it("answers one body for a taken and a free address to a caller without the users scope", async () => {
    const w = await world();
    expect(
      await w.api.create({
        actor: w.desk,
        email: "taken@example.com",
        firstSignIn: "none",
        ...REASON,
      }),
    ).toMatchObject({ ok: true });
    const keys = await secretActor(w, OPERATOR_SECRETS.keys);
    const mails = w.mail.length;
    const calls = spyStorage(w.config.storage);
    const taken = await w.api.create({ actor: keys, email: "taken@example.com", ...REASON });
    const free = await w.api.create({ actor: keys, email: "free@example.com", ...REASON });
    expect(taken).toEqual({ ok: false, code: "operator_required", status: 403 });
    expect(free).toEqual(taken);
    // The scope check comes before any read: no storage call at all.
    expect(calls).toEqual([]);
    expect(w.mail.length).toBe(mails);
    expect((await users(w)).map((u) => u.email)).toEqual(["taken@example.com"]);
  });

  it("creates a user with an address and no credential", async () => {
    const w = await world();
    const done = await w.api.create({
      actor: w.desk,
      email: " Ada@Example.com ",
      emailVerified: false,
      name: "Ada",
      image: "https://img.example.com/ada.png",
      firstSignIn: "none",
      ...REASON,
    });
    if (!done.ok) throw new Error(done.code);
    expect(Object.keys(done.value).sort()).toEqual(["auditId", "mailed", "userId"]);
    expect(done.value.mailed).toBeNull();
    expect(await users(w)).toEqual([
      expect.objectContaining({
        id: done.value.userId,
        email: ADA,
        emailVerified: false,
        name: "Ada",
        image: "https://img.example.com/ada.png",
        phone: null,
      }),
    ]);
    expect(await w.storage.findMany("password", [])).toEqual([]);
    expect(await w.storage.findMany("identity", [])).toEqual([]);
    expect(w.mail).toEqual([]);
  });

  it("writes the email identity for a verified address", async () => {
    const w = await world();
    const done = await w.api.create({
      actor: w.desk,
      email: ADA,
      emailVerified: true,
      firstSignIn: "none",
      ...REASON,
    });
    if (!done.ok) throw new Error(done.code);
    const identities = await w.storage.findMany("identity", []);
    expect(identities.map((i) => [i.userId, i.provider, i.subject])).toEqual([
      [done.value.userId, "email", ADA],
    ]);
    expect(await w.storage.findMany("password", [])).toEqual([]);
  });

  it("answers email_taken to a caller with the users scope, and mails no one", async () => {
    const w = await world();
    expect(
      await w.api.create({ actor: w.desk, email: ADA, firstSignIn: "none", ...REASON }),
    ).toMatchObject({ ok: true });
    const support = await secretActor(w, OPERATOR_SECRETS.support);
    const again = await w.api.create({
      actor: support,
      email: ADA,
      firstSignIn: "reset",
      ...REASON,
    });
    expect(again).toEqual({ ok: false, code: "email_taken", status: 409 });
    expect(w.mail).toEqual([]);
    expect(await users(w)).toHaveLength(1);
    expect(await auditRows(w)).toHaveLength(1);
  });

  it("creates a phone user with no address and sends no SMS", async () => {
    const w = await world();
    const done = await w.api.create({ actor: w.desk, email: null, phone: PHONE, ...REASON });
    if (!done.ok) throw new Error(done.code);
    expect(done.value.mailed).toBeNull();
    expect(await users(w)).toEqual([
      expect.objectContaining({ id: done.value.userId, email: null, phone: PHONE }),
    ]);
    expect(w.sms.sent).toEqual([]);
    expect(w.mail).toEqual([]);
    expect(
      await w.api.create({
        actor: w.desk,
        email: null,
        phone: "+15555550101",
        firstSignIn: "invite",
        ...REASON,
      }),
    ).toEqual({ ok: false, code: "invalid_body", status: 400 });
    expect(await users(w)).toHaveLength(1);
  });

  it("signs the phone user in by a phone code", async () => {
    const w = await world();
    const done = await w.api.create({ actor: w.desk, email: null, phone: PHONE, ...REASON });
    if (!done.ok) throw new Error(done.code);
    const handle = settled(createRouter(w.config, coreRoutes(w.config)));
    const headers = { "cf-connecting-ip": "198.51.100.7" };
    const asked = await handle(post("/auth/phone/request", { phone: PHONE }, headers));
    expect(asked.status).toBe(200);
    const code = /^(\d+) is your /.exec(w.sms.sent.at(-1)?.text ?? "")?.[1];
    if (code === undefined) throw new Error("no code");
    const res = await handle(post("/auth/phone/verify", { phone: PHONE, code }, headers));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { id: string } };
    expect(body.user?.id).toBe(done.value.userId);
    expect(await users(w)).toHaveLength(1);
  });

  it("refuses a phone outside the rules", async () => {
    const w = await world();
    expect(
      await w.api.create({ actor: w.desk, email: null, phone: "5555550100", ...REASON }),
    ).toEqual({ ok: false, code: "phone_invalid", status: 400 });
    expect(
      await w.api.create({ actor: w.desk, email: null, phone: "+445555550100", ...REASON }),
    ).toMatchObject({ ok: false, code: "phone_region" });
    const off = await bare(false);
    expect(off.config.phone).toBeNull();
    expect(await off.api.create({ actor: off.desk, email: null, phone: PHONE, ...REASON })).toEqual(
      { ok: false, code: "invalid_body", status: 400 },
    );
    expect(await users(w)).toEqual([]);
    expect(await users(off)).toEqual([]);
  });

  it("answers phone_taken for a taken number", async () => {
    const w = await world();
    expect(
      await w.api.create({ actor: w.desk, email: null, phone: PHONE, ...REASON }),
    ).toMatchObject({ ok: true });
    expect(
      await w.api.create({
        actor: w.desk,
        email: "pat@example.com",
        emailVerified: true,
        phone: PHONE,
        firstSignIn: "none",
        ...REASON,
      }),
    ).toEqual({ ok: false, code: "phone_taken", status: 409 });
    expect(await users(w)).toHaveLength(1);
    expect(await auditRows(w)).toHaveLength(1);
  });

  it("refuses a user with no address and no phone", async () => {
    const w = await world();
    expect(await w.api.create({ actor: w.desk, email: null, ...REASON })).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
    expect(await users(w)).toEqual([]);
    expect(await auditRows(w)).toEqual([]);
  });

  it("refuses the verified flag and the first sign-in without an address", async () => {
    const w = await world();
    const refused = { ok: false, code: "invalid_body", status: 400 };
    expect(
      await w.api.create({
        actor: w.desk,
        email: null,
        phone: PHONE,
        emailVerified: true,
        ...REASON,
      }),
    ).toEqual(refused);
    expect(
      await w.api.create({
        actor: w.desk,
        email: null,
        phone: PHONE,
        firstSignIn: "reset",
        ...REASON,
      }),
    ).toEqual(refused);
    const noPassword = await bare(true);
    expect(noPassword.config.password).toBeNull();
    expect(
      await noPassword.api.create({
        actor: noPassword.desk,
        email: ADA,
        firstSignIn: "reset",
        ...REASON,
      }),
    ).toEqual(refused);
    expect(await users(w)).toEqual([]);
    expect(await users(noPassword)).toEqual([]);
  });

  it("refuses a phone on an unverified address", async () => {
    // A proof of the address clears the phone (claimEmail, plan 12i), so the
    // create sets a phone only beside a verified address (plan 12f2 Task 1).
    const w = await world();
    expect(await w.api.create({ actor: w.desk, email: ADA, phone: PHONE, ...REASON })).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
    expect(await users(w)).toEqual([]);
    const done = await w.api.create({
      actor: w.desk,
      email: ADA,
      emailVerified: true,
      phone: PHONE,
      firstSignIn: "none",
      ...REASON,
    });
    if (!done.ok) throw new Error(done.code);
    expect(await users(w)).toEqual([
      expect.objectContaining({ email: ADA, emailVerified: true, phone: PHONE }),
    ]);
  });

  it("mails a reset link for firstSignIn reset", async () => {
    const w = await world();
    const done = await w.api.create({ actor: w.desk, email: ADA, firstSignIn: "reset", ...REASON });
    if (!done.ok) throw new Error(done.code);
    expect(done.value.mailed).toBe("reset");
    expect(w.mail.map((m) => m.to)).toEqual([ADA]);
    expect(w.mail[0]?.text).toMatch(/\/password\/reset\?token=pr_/);
    expect(JSON.stringify(done)).not.toContain("pr_");
    expect(JSON.stringify(await auditRows(w))).not.toContain("pr_");
    const rows = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-reset" },
    ]);
    expect(rows.map((r) => r.identifier)).toEqual([ADA]);
  });

  it("keeps the user when the mail fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = await world({
      mail: {
        send: async () => {
          throw new TypeError("mail down");
        },
      },
    });
    const done = await w.api.create({ actor: w.desk, email: ADA, firstSignIn: "reset", ...REASON });
    if (!done.ok) throw new Error(done.code);
    expect(done.value.mailed).toBeNull();
    expect(log.mock.calls).toEqual([
      ["authtempo: operator create mail failed", done.value.userId, "TypeError"],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(ADA);
    expect((await users(w)).map((u) => u.id)).toEqual([done.value.userId]);
    expect(await auditRows(w)).toHaveLength(1);
  });

  it("writes the audit row with flags only", async () => {
    const w = await world();
    const done = await w.api.create({
      actor: w.desk,
      email: ADA,
      name: "Ada Lovelace",
      firstSignIn: "none",
      ...REASON,
    });
    if (!done.ok) throw new Error(done.code);
    const [row, ...rest] = await auditRows(w);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      id: done.value.auditId,
      action: "user_create",
      actorKind: "app",
      actorId: "support-desk",
      targetUserId: done.value.userId,
      reason: "Ticket 4521",
    });
    expect(row?.data).toEqual({
      emailVerified: false,
      firstSignIn: "none",
      hasAddress: true,
      hasPhone: false,
    });
    const text = JSON.stringify(row);
    expect(text).not.toContain("ada@");
    expect(text).not.toContain("Lovelace");
    const phoned = await w.api.create({ actor: w.desk, email: null, phone: PHONE, ...REASON });
    if (!phoned.ok) throw new Error(phoned.code);
    const last = (await auditRows(w)).at(-1);
    expect(last?.data).toEqual({
      emailVerified: false,
      firstSignIn: "none",
      hasAddress: false,
      hasPhone: true,
    });
    expect(JSON.stringify(last)).not.toContain(PHONE.slice(1));
  });

  it("runs the hooks with via operator, and writes nothing on a refusal", async () => {
    const w = await world();
    const done = await w.api.create({ actor: w.desk, email: ADA, firstSignIn: "none", ...REASON });
    if (!done.ok) throw new Error(done.code);
    expect(w.hooks).toEqual(["beforeCreate:operator", "afterCreate:operator"]);
    const refusing = await world({
      hooks: {
        user: {
          beforeCreate: () => {
            throw hookRefusal("not here");
          },
        },
      },
    });
    expect(
      await refusing.api.create({ actor: refusing.desk, email: ADA, ...REASON }),
    ).toMatchObject({ ok: false, code: "hook_refused" });
    expect(await users(refusing)).toEqual([]);
    expect(await auditRows(refusing)).toEqual([]);
    const vetoed = await world({
      hooks: {
        operator: {
          beforeAction: () => {
            throw hookRefusal("no creates today");
          },
        },
      },
    });
    expect(await vetoed.api.create({ actor: vetoed.desk, email: ADA, ...REASON })).toMatchObject({
      ok: false,
      code: "hook_refused",
    });
    expect(await users(vetoed)).toEqual([]);
    expect(await auditRows(vetoed)).toEqual([]);
    expect(vetoed.mail).toEqual([]);
  });

  it("creates at a closed sign-up", async () => {
    const w = await world({ signUp: false });
    const done = await w.api.create({ actor: w.desk, email: ADA, firstSignIn: "none", ...REASON });
    expect(done).toMatchObject({ ok: true });
    expect((await users(w)).map((u) => u.email)).toEqual([ADA]);
  });
});
