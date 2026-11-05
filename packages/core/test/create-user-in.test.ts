import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createSteps } from "../src/engine/create-steps.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { createUserIn, type NewUserInput, takenCode } from "../src/engine/users.js";
import { fail, ok } from "../src/result.js";
import { StorageError } from "../src/storage/port.js";
import { makeAuth, tokenFromMail } from "./helpers.js";
import { operatorAuth } from "./operator-helpers.js";

const ADA = "ada@example.com";
const PHONE = "+15555550100";

/** One `createUserIn` in its own transaction, with the steps of the operator create. */
function creator(overrides: Partial<AuthConfig> = {}) {
  const auth = makeAuth(overrides);
  const create = (input: NewUserInput, options?: Parameters<typeof createUserIn>[4]) => {
    const steps = createSteps(auth.config, "operator", { signUpRule: false });
    return auth.storage.transaction((tx) =>
      createUserIn(tx, steps, input, auth.clock.now(), options),
    );
  };
  return { auth, create };
}

const unverified: NewUserInput = { email: ADA, emailVerified: false, name: null, image: null };

describe("createUserIn", () => {
  it("writes the user and the email identity for a verified address", async () => {
    const { auth, create } = creator();
    const made = await create({ ...unverified, emailVerified: true, name: "Ada" });
    if (!made.ok) throw new Error(made.code);
    expect(made.value).toMatchObject({ email: ADA, emailVerified: true, name: "Ada", phone: null });
    expect(await auth.storage.findMany("user", [])).toEqual([made.value]);
    const identities = await auth.storage.findMany("identity", []);
    expect(identities.map((i) => [i.userId, i.provider, i.subject])).toEqual([
      [made.value.id, "email", ADA],
    ]);
  });

  it("writes no identity for an unverified address, and none for a phone user", async () => {
    const { auth, create } = creator();
    const plain = await create(unverified);
    const phoned = await create({
      email: null,
      emailVerified: false,
      name: null,
      image: null,
      phone: PHONE,
    });
    if (!plain.ok || !phoned.ok) throw new Error("a create failed");
    expect(phoned.value).toMatchObject({ email: null, emailVerified: false, phone: PHONE });
    expect(await auth.storage.findMany("user", [])).toHaveLength(2);
    expect(await auth.storage.findMany("identity", [])).toEqual([]);
  });

  it("answers email_taken and phone_taken before any write", async () => {
    const seen: string[] = [];
    const { auth, create } = creator({
      hooks: { user: { beforeCreate: (e) => void seen.push(e.user.id) } },
    });
    const first = await create({ ...unverified, emailVerified: true, phone: PHONE });
    if (!first.ok) throw new Error(first.code);
    expect(await create(unverified)).toEqual(fail("email_taken"));
    expect(
      await create({ email: null, emailVerified: false, name: null, image: null, phone: PHONE }),
    ).toEqual(fail("phone_taken"));
    // No hook saw a refused create, and no row came of it.
    expect(seen).toEqual([first.value.id]);
    expect(await auth.storage.findMany("user", [])).toHaveLength(1);
    expect(await auth.storage.findMany("identity", [])).toHaveLength(1);
  });

  it("applies the patch of user.beforeCreate", async () => {
    const events: string[] = [];
    const { auth, create } = creator({
      hooks: {
        user: {
          beforeCreate: (e) => {
            events.push(`${e.via}:${e.user.email}`);
            return { name: "Patched" };
          },
        },
      },
    });
    const made = await create(unverified);
    if (!made.ok) throw new Error(made.code);
    expect(events).toEqual([`operator:${ADA}`]);
    expect((await auth.storage.findMany("user", []))[0]?.name).toBe("Patched");
  });

  it("maps a lost race after the transaction", () => {
    expect(takenCode(new StorageError("unique_violation", "user", ["email"]))).toBe("email_taken");
    expect(takenCode(new StorageError("unique_violation", "user", ["phone"]))).toBe("phone_taken");
    expect(takenCode(new StorageError("unique_violation", "user", ["id"]))).toBeNull();
    expect(takenCode(new StorageError("unique_violation", "session", ["email"]))).toBeNull();
    expect(takenCode(new StorageError("invalid_argument", "user", ["email"]))).toBeNull();
    expect(takenCode(new Error("unique_violation"))).toBeNull();
  });

  it("runs the before step after the hooks, and writes nothing on its refusal", async () => {
    const events: string[] = [];
    const { auth, create } = creator({
      hooks: { user: { beforeCreate: () => void events.push("user.beforeCreate") } },
    });
    const refused = await create(unverified, {
      before: async (_tx, user) => {
        events.push(`before:${user.email}`);
        return fail("conflict");
      },
    });
    expect(refused).toEqual(fail("conflict"));
    expect(events).toEqual(["user.beforeCreate", `before:${ADA}`]);
    expect(await auth.storage.findMany("user", [])).toEqual([]);
    const made = await create(unverified, { before: async () => ok(true) });
    expect(made.ok).toBe(true);
  });

  it("sends no read of the address when the caller read it", async () => {
    const { auth, create } = creator();
    await auth.seedUser(ADA);
    // The caller says the address is free: the unique key, not a read, refuses it.
    await expect(create(unverified, { addressRead: true })).rejects.toMatchObject({
      code: "unique_violation",
      model: "user",
    });
    expect(await create(unverified)).toEqual(fail("email_taken"));
  });

  it("throws on an input that no caller may pass", async () => {
    const { auth, create } = creator();
    const none = { email: null, emailVerified: false, name: null, image: null } as const;
    await expect(create({ ...none, emailVerified: true, phone: PHONE })).rejects.toThrow(
      /verified/,
    );
    await expect(create(none)).rejects.toThrow(/an address or a phone/);
    // A proof of the address clears the phone (claimEmail), so core never sets one on an unverified address.
    await expect(create({ ...unverified, phone: PHONE })).rejects.toThrow(/phone/);
    expect(await auth.storage.findMany("user", [])).toEqual([]);
  });
});

describe("the callers of createUserIn", () => {
  // Measured on the memory adapter at a107e164, before the move (2026-10-25):
  // createAdmin on a fresh database 8, a magic-link sign-up 9.
  // Each caller read the address itself, so the shared create adds no read.
  // Plan 12q adds the cap read to each session create: the sign-up sends 10
  // (measured on the memory adapter on 2026-11-05).
  it("send the statements of before the move", async () => {
    const auth = await operatorAuth();
    const sent = () => auth.storage.statementsSent?.() ?? 0;
    let start = sent();
    const admin = await operatorApi(auth.config).createAdmin({
      actor: { kind: "app", name: "setup-script" },
      email: "admin@example.com",
      reason: "First operator of the deployment",
      ip: null,
      userAgent: null,
    });
    if (!admin.ok) throw new Error(admin.code);
    const adminSent = sent() - start;
    await requestMagicLink(auth.config, { email: ADA, ip: null });
    const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    start = sent();
    const link = await verifyMagicLink(auth.config, { token, ip: null, userAgent: null });
    if (!link.ok) throw new Error(link.code);
    expect({ adminSent, signUpSent: sent() - start }).toEqual({ adminSent: 8, signUpSent: 10 });
  });
});
