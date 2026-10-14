import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/create-auth.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { base32Decode, totpCode } from "../src/primitives/totp.js";
import type { VerificationPurpose } from "../src/schema.js";
import { createPbkdf2PasswordHash } from "../src/seams/password-hash.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";

const S1 = "0123456789abcdef0123456789abcdef";
const S2 = "q8JxVd3m0Yv2sZ7rKpT4wN1hLc9eFgAuBiOjQyRtSxM";
const AT = new Date("2026-10-14T00:00:00.000Z");
const PW = "correct horse battery";
const FAST = createPbkdf2PasswordHash({ iterations: 1000 });

function authOn(
  storage: StorageAdapter,
  secrets: Array<{ version: number; value: string }>,
  clock: { now: () => Date } = { now: () => AT },
  mail: string[] = [],
) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    storage,
    mail: {
      send: async (m) => {
        mail.push(m.text);
      },
    },
    clock,
    secrets,
    password: { hash: FAST },
  });
}

async function seed(storage: StorageAdapter): Promise<void> {
  const base = { createdAt: AT, updatedAt: AT };
  for (const [id, v] of [
    ["f1", 1],
    ["f2", 1],
    ["f3", 9],
  ] as const)
    await storage.create("totp", {
      id,
      userId: `u-${id}`,
      secret: "not-a-sealed-value",
      enabledAt: AT,
      lastStep: 0,
      backupCodes: [],
      secretVersion: v,
      ...base,
    });
  await storage.create("secondFactor", {
    id: "f1",
    userId: "u-f1",
    enabledAt: AT,
    methods: ["totp"],
    backupCodes: ["a", "b", "c"],
    backupCodesVersion: 2,
    secretVersion: 1,
    ...base,
  });
  const live = new Date(AT.getTime() + 60_000);
  const code = (
    id: string,
    purpose: VerificationPurpose,
    o: { expiresAt?: Date; version?: number; data?: Record<string, unknown>; spent?: boolean } = {},
  ) =>
    storage.create("verification", {
      id,
      purpose,
      identifier: "a@example.com",
      valueHash: `h-${id}`,
      expiresAt: o.expiresAt ?? live,
      consumedAt: o.spent ? AT : null,
      data: o.data ?? null,
      secretVersion: o.version ?? 1,
      ...base,
    });
  // Counted under version 1: a live email code, a live reset code, and a challenge that holds an email code.
  await code("v1", "email-otp");
  await code("v4", "password-reset-otp");
  await code("v5", "two-factor", { data: { attempts: 0, emailCodeHash: "h" } });
  // Not counted: an expired code, a spent code, a challenge with no email code, and an unkeyed magic link.
  await code("v2", "email-otp", { expiresAt: new Date(AT.getTime() - 1) });
  await code("v7", "email-otp", { spent: true });
  await code("v6", "two-factor", { data: { attempts: 0 } });
  await code("v3", "magic-link", { version: 2 });
}

describe("api.secrets (plan 12b)", () => {
  it("counts the rows per version, lists an unknown version, and counts live keyed codes only", async () => {
    const storage = createMemoryAdapter();
    await seed(storage);
    const auth = authOn(storage, [
      { version: 2, value: S2 },
      { version: 1, value: S1 },
    ]);
    expect(await auth.api.secrets.status()).toEqual({
      versions: [
        {
          version: 2,
          configured: true,
          current: true,
          totpSecrets: 0,
          backupCodes: 0,
          signingKeys: 0,
          emailCodes: 0,
        },
        {
          version: 1,
          configured: true,
          current: false,
          totpSecrets: 2,
          backupCodes: 3,
          signingKeys: 0,
          emailCodes: 3,
        },
        {
          version: 9,
          configured: false,
          current: false,
          totpSecrets: 1,
          backupCodes: 0,
          signingKeys: 0,
          emailCodes: 0,
        },
      ],
    });
  });

  it("refuses a limit outside 1 to 1000 and a cursor that it did not answer", async () => {
    const auth = authOn(createMemoryAdapter(), [{ version: 1, value: S1 }]);
    for (const input of [
      { limit: 0 },
      { limit: 1001 },
      { limit: 1.5 },
      { limit: Number.NaN },
      { after: "" },
      { after: "totp:" },
      { after: "user:f1" },
    ])
      expect(await auth.api.secrets.rewrap(input)).toEqual({
        ok: false,
        code: "invalid_body",
        status: 400,
      });
  });

  it("does nothing when no old version is configured", async () => {
    const storage = createMemoryAdapter();
    await seed(storage);
    const auth = authOn(storage, [{ version: 1, value: S1 }]);
    expect(await auth.api.secrets.rewrap()).toEqual({
      ok: true,
      value: { resealed: 0, failed: 0, skipped: 0, more: false, next: null },
    });
  });

  it("reads only the configured old versions and counts a row that does not open as failed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = createMemoryAdapter();
    await seed(storage);
    const auth = authOn(storage, [
      { version: 2, value: S2 },
      { version: 1, value: S1 },
    ]);
    // f1 and f2 hold no sealed value, so they fail; f3 names version 9 and is never read.
    expect(await auth.api.secrets.rewrap({ limit: 1 })).toEqual({
      ok: true,
      value: { resealed: 0, failed: 1, skipped: 0, more: true, next: "totp:f1" },
    });
    // The cursor passes the row that failed: the next call reads f2.
    expect(await auth.api.secrets.rewrap({ limit: 1, after: "totp:f1" })).toEqual({
      ok: true,
      value: { resealed: 0, failed: 1, skipped: 0, more: true, next: "totp:f2" },
    });
    expect(await auth.api.secrets.rewrap({ limit: 5 })).toEqual({
      ok: true,
      value: { resealed: 0, failed: 2, skipped: 0, more: true, next: null },
    });
    log.mockRestore();
  });

  it("moves a TOTP row and a key past a row that fails, skips a live setup, and reseals it after 15 minutes", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = createMemoryAdapter();
    let current = AT;
    const clock = { now: () => current };
    const mail: string[] = [];
    const ONE = [{ version: 1, value: S1 }];
    const v1 = authOn(storage, ONE, clock, mail);
    // A row that sorts before every id of the engine and does not open.
    await storage.create("totp", {
      id: "0-bad",
      userId: "u-bad",
      secret: "not-a-sealed-value",
      enabledAt: AT,
      lastStep: 0,
      backupCodes: [],
      secretVersion: 1,
      createdAt: AT,
      updatedAt: AT,
    });
    const user = async (id: string, email: string) => {
      await storage.create("user", {
        id,
        email,
        emailVerified: true,
        name: null,
        image: null,
        createdAt: AT,
        updatedAt: AT,
      });
      await storage.create("password", {
        id: `${id}-pw`,
        userId: id,
        hash: await FAST.hash(PW),
        createdAt: AT,
        updatedAt: AT,
      });
    };
    // Ada has a live setup with backup codes. Cy has the factor on.
    await user("01JA0000000000000000000U11", "ada@example.com");
    await user("01JA0000000000000000000U12", "cy@example.com");
    const live = await v1.api.totp?.setup({ userId: "01JA0000000000000000000U11", password: PW });
    expect(live?.ok && live.value.backupCodes.length > 0).toBe(true);
    const cySetup = await v1.api.totp?.setup({
      userId: "01JA0000000000000000000U12",
      password: PW,
    });
    if (!cySetup?.ok) throw new Error("no setup");
    must(await v1.api.emailOtp?.request({ email: "cy@example.com", ip: null }));
    const signedIn = must(
      await v1.api.emailOtp?.verify({
        email: "cy@example.com",
        code: /\b(\d{6})\b/.exec(mail.at(-1) ?? "")?.[1] ?? "",
        ip: null,
        userAgent: null,
      }),
    );
    if (!("token" in signedIn)) throw new Error("no session");
    const session = await v1.api.getSession(signedIn.token);
    if (!session) throw new Error("no session");
    must(
      await v1.api.totp?.enable({
        session,
        code: await totpCode(base32Decode(cySetup.value.secret), clock.now()),
      }),
    );
    // A signing key under version 1.
    const cyId = "01JA0000000000000000000U12";
    const old = must(await v1.api.jwt?.mint({ userId: cyId, sessionId: session.session.id }));
    const v2 = authOn(storage, [{ version: 2, value: S2 }, ...ONE], clock, mail);
    // The first call reads the row that fails, and the cursor goes on past it.
    const first = must(await v2.api.secrets.rewrap({ limit: 1 }));
    expect(first).toEqual({ resealed: 0, failed: 1, skipped: 0, more: true, next: "totp:0-bad" });
    const sum = { resealed: 0, failed: 1, skipped: 0 };
    let next = first.next;
    let more = first.more;
    for (let round = 0; next !== null && round < 10; round++) {
      const r = must(await v2.api.secrets.rewrap({ limit: 1, after: next }));
      sum.resealed += r.resealed;
      sum.failed += r.failed;
      sum.skipped += r.skipped;
      next = r.next;
      more = r.more;
    }
    // Cy's TOTP secret and the signing key move.
    expect({ ...sum, more, next }).toEqual({
      resealed: 2,
      failed: 1,
      skipped: 1,
      more: true,
      next: null,
    });
    // After the 15 minutes of the setup, a new pass reseals it.
    current = new Date(AT.getTime() + 15 * 60_000);
    expect(must(await v2.api.secrets.rewrap())).toEqual({
      resealed: 1,
      failed: 1,
      skipped: 0,
      more: true,
      next: null,
    });
    const one = (await v2.api.secrets.status()).versions.find((v) => v.version === 1);
    expect({ totp: one?.totpSecrets, keys: one?.signingKeys }).toEqual({ totp: 1, keys: 0 });
    // The resealed key opens under version 2 alone: it signs again with its kid.
    const only2 = authOn(storage, [{ version: 2, value: S2 }], clock, mail);
    const minted = must(await only2.api.jwt?.mint({ userId: cyId, sessionId: session.session.id }));
    expect(decodeJws(minted.token)?.header.kid).toBe(decodeJws(old.token)?.header.kid);
    log.mockRestore();
  });
});

function must<T>(r: { ok: true; value: T } | { ok: false; code: string } | undefined): T {
  if (!r?.ok) throw new Error(`secrets test: ${r ? r.code : "no api"}`);
  return r.value;
}
