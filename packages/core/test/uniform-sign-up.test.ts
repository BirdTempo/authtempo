import { describe, expect, it } from "vitest";
import { type AuthConfig, ConfigError } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { TEST_SECRET } from "../src/testing/soft-authenticator.js";
import { FAST } from "./password-helpers.js";

const BASE = "https://api.example.com";
const PW = "correct horse battery";

function setup(password: AuthConfig["password"] = { hash: FAST }, extra: Partial<AuthConfig> = {}) {
  const storage = extra.storage ?? createMemoryAdapter();
  const mail: Array<{ to: string; subject: string; text: string }> = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: TEST_SECRET,
    trustedOrigins: [],
    storage,
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    password,
    ...extra,
  });
  return { auth, storage, mail };
}

const signUp = (auth: ReturnType<typeof createAuth>, email: string, ip = "203.0.113.9") =>
  auth.handle(
    new Request(`${BASE}/auth/password/sign-up`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ email, password: PW }),
    }),
  );

async function seedUser(storage: StorageAdapter, email: string, verified: boolean) {
  const at = new Date();
  await storage.create("user", {
    id: `u-${email}`,
    email,
    emailVerified: verified,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    createdAt: at,
    updatedAt: at,
  });
}

async function seedInvitation(storage: StorageAdapter, email: string) {
  const at = new Date();
  await storage.create("invitation", {
    id: `i-${email}`,
    organizationId: "o1",
    email,
    role: "member",
    inviterId: "u0",
    tokenHash: `h-${email}`,
    expiresAt: new Date(at.getTime() + 86_400_000),
    acceptedAt: null,
    teamIds: null,
    createdAt: at,
    updatedAt: at,
  });
}

/** Status, every header but the date, and the body text. */
async function bytes(res: Response) {
  // The trace header is random for each answer (plan 12h Task 4). Each answer
  // carries one, and the compare leaves it out.
  expect(res.headers.get("x-authtempo-trace")).toMatch(/^[0-9a-f]{32}$/);
  const headers = [...res.headers.entries()].filter(([k]) => k !== "x-authtempo-trace");
  return { status: res.status, headers, body: await res.text() };
}

describe("the uniform sign-up (plan 12b)", () => {
  it("answers a new address with sent, no cookie, and the verify mail; the verify opens the session", async () => {
    const { auth, storage, mail } = setup();
    const res = await signUp(auth, "new@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await storage.findMany("session", [])).toEqual([]);
    const [user] = await storage.findMany("user", []);
    expect(user?.emailVerified).toBe(false);
    expect(mail.map((m) => [m.to, m.subject])).toEqual([
      ["new@example.com", "Confirm your email for api.example.com"],
    ]);
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail[0]?.text ?? "")?.[1] ?? "";
    const verified = await auth.handle(
      new Request(`${BASE}/auth/password/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
    );
    expect(verified.status).toBe(200);
    expect(verified.headers.getSetCookie()[0]).toMatch(/^__Host-tempo_session=ts_/);
  });

  it("answers a known address with sent and mails its owner, for a verified and an unverified user", async () => {
    for (const verified of [true, false]) {
      const { auth, storage, mail } = setup();
      await seedUser(storage, "ada@example.com", verified);
      const res = await signUp(auth, "ada@example.com");
      expect(await res.json()).toEqual({ sent: true });
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await storage.findMany("password", [])).toEqual([]);
      expect(mail.map((m) => [m.to, m.subject])).toEqual([
        ["ada@example.com", "Your account at api.example.com"],
      ]);
    }
  });

  it("answers a known address and a new address with equal bytes (Review Focus 3)", async () => {
    const known = setup();
    await seedUser(known.storage, "ada@example.com", true);
    const fresh = setup();
    expect(await bytes(await signUp(known.auth, "ada@example.com"))).toEqual(
      await bytes(await signUp(fresh.auth, "ada@example.com")),
    );
  });

  it("writes nothing and mails nothing when a claim finds the new user inside the sign-up", async () => {
    const base = createMemoryAdapter();
    // A proof of the address commits between the password create and the guard.
    const racing: StorageAdapter = {
      ...base,
      transaction: (fn) =>
        base.transaction((tx) =>
          fn({
            ...tx,
            async create(model, data) {
              const row = await tx.create(model, data);
              if (model === "password")
                await tx.update(
                  "user",
                  [{ field: "id", op: "eq", value: (data as { userId: string }).userId }],
                  { emailVerified: true },
                );
              return row;
            },
          } as StorageAdapter),
        ),
    };
    const { auth, mail } = setup({ hash: FAST }, { storage: racing });
    expect(await (await signUp(auth, "new@example.com")).json()).toEqual({ sent: true });
    expect(await base.findMany("password", [])).toEqual([]);
    expect(mail).toEqual([]);
  });

  it("leaves one user when two sign-ups of one new address run at once", async () => {
    const { auth, storage } = setup();
    const answers = await Promise.all([
      signUp(auth, "new@example.com"),
      signUp(auth, "new@example.com"),
    ]);
    expect(await Promise.all(answers.map((r) => r.json()))).toEqual([
      { sent: true },
      { sent: true },
    ]);
    expect(await storage.findMany("user", [])).toHaveLength(1);
  });

  it("limits sign-ups per address to 5 per hour, for a new and a known address alike", async () => {
    const { auth, storage } = setup();
    await seedUser(storage, "ada@example.com", true);
    // One IP per address, so the per-IP limit (10 per hour) does not answer first.
    for (const [email, ip] of [
      ["ada@example.com", "203.0.113.1"],
      ["new@example.com", "203.0.113.2"],
    ] as const) {
      for (let i = 0; i < 5; i++) expect((await signUp(auth, email, ip)).status).toBe(200);
      expect(await (await signUp(auth, email, ip)).json()).toEqual({ error: "rate_limited" });
    }
  });

  it("sends the app's existing-account mail to the address, whatever its to", async () => {
    const { auth, storage, mail } = setup({
      hash: FAST,
      existingAccountMail: (input) => ({
        to: "someone-else@example.com",
        subject: "Hello",
        text: `You have an account at ${input.appName}: ${input.appURL}`,
      }),
    });
    await seedUser(storage, "ada@example.com", true);
    await signUp(auth, "ada@example.com");
    expect(mail).toEqual([
      {
        to: "ada@example.com",
        subject: "Hello",
        text: "You have an account at api.example.com: https://api.example.com",
      },
    ]);
  });

  it("sends nothing for an address that the invited rule refuses", async () => {
    const { auth, storage, mail } = setup({ hash: FAST }, { signUp: "invited", organizations: {} });
    expect(await (await signUp(auth, "new@example.com")).json()).toEqual({ sent: true });
    expect(await storage.findMany("user", [])).toEqual([]);
    expect(mail).toEqual([]);
  });

  it("under invited, mails a known address only with an invitation, as a new address (Task 8 order)", async () => {
    const { auth, storage, mail } = setup({ hash: FAST }, { signUp: "invited", organizations: {} });
    await seedUser(storage, "ada@example.com", true);
    // No invitation: the rule refuses before the existence read, so no mail, as for a new address.
    expect(await (await signUp(auth, "ada@example.com", "203.0.113.1")).json()).toEqual({
      sent: true,
    });
    expect(mail).toEqual([]);
    // An invitation for each: the known address gets the account mail, the new one the verify mail.
    await seedInvitation(storage, "ada@example.com");
    await seedInvitation(storage, "new@example.com");
    expect(await (await signUp(auth, "ada@example.com", "203.0.113.2")).json()).toEqual({
      sent: true,
    });
    expect(await (await signUp(auth, "new@example.com", "203.0.113.3")).json()).toEqual({
      sent: true,
    });
    expect(mail.map((m) => [m.to, m.subject])).toEqual([
      ["ada@example.com", "Your account at api.example.com"],
      ["new@example.com", "Confirm your email for api.example.com"],
    ]);
  });

  it("keeps the uniform answer while requireVerified is on (Task 15)", async () => {
    const { auth, storage, mail } = setup({ hash: FAST, requireVerified: true });
    await seedUser(storage, "ada@example.com", true);
    const known = await signUp(auth, "ada@example.com");
    const fresh = await signUp(auth, "new@example.com");
    // The status, the headers (no cookie), and the body, not only the body (Task 9 review L2).
    const knownBytes = await bytes(known);
    expect(knownBytes).toEqual(await bytes(fresh));
    expect(knownBytes.status).toBe(200);
    expect(knownBytes.body).toBe(JSON.stringify({ sent: true }));
    expect(known.headers.getSetCookie()).toEqual([]);
    expect(mail.map((m) => m.to)).toEqual(["ada@example.com", "new@example.com"]);
  });

  it("keeps the answer of plan 8 with uniformSignUp false", async () => {
    const { auth, storage } = setup({ hash: FAST, uniformSignUp: false });
    await seedUser(storage, "ada@example.com", true);
    expect(await (await signUp(auth, "ada@example.com")).json()).toEqual({ error: "email_taken" });
    const fresh = await signUp(auth, "new@example.com");
    expect(fresh.headers.getSetCookie()[0]).toMatch(/^__Host-tempo_session=ts_/);
  });

  it("refuses a uniformSignUp that is not a boolean and a mail that is not a function", () => {
    expect(() => setup({ hash: FAST, uniformSignUp: "yes" as never })).toThrow(
      new ConfigError("password.uniformSignUp must be a boolean"),
    );
    expect(() => setup({ hash: FAST, existingAccountMail: "x" as never })).toThrow(
      new ConfigError("password.existingAccountMail must be a function"),
    );
  });
});
