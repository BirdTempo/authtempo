import { describe, expect, it } from "vitest";
import {
  disableTotp,
  regenerateBackupCodesWithCode,
  setupTotp,
  totpStatus,
} from "../src/engine/totp.js";
import { hmacSha256Hex } from "../src/primitives/crypto.js";
import { normalizeBackupCode } from "../src/primitives/totp.js";
import { enrolled, PASSWORD, totpAuth, verifiedSession } from "./totp-helpers.js";

/** A backup code of 23 characters of core's alphabet, shown as 5-5-5-4-4. */
const GROUPED =
  /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/;

describe("the factor row (plan 12c)", () => {
  it("writes the row at the first enable with the totp row's id, version 2, and the hashes of the codes with no dash", async () => {
    const auth = totpAuth();
    const { user, backupCodes } = await enrolled(auth);
    expect(backupCodes).toHaveLength(10);
    for (const c of backupCodes) expect(c).toMatch(GROUPED);
    const [totp] = await auth.storage.findMany("totp", []);
    const [factor] = await auth.storage.findMany("secondFactor", []);
    expect(factor).toMatchObject({
      id: totp?.id,
      userId: user.id,
      methods: ["totp"],
      backupCodesVersion: 2,
    });
    expect(factor?.backupCodes).toEqual(
      await Promise.all(
        backupCodes.map((c) =>
          hmacSha256Hex(auth.config.secret, `${factor?.id}:${normalizeBackupCode(c)}`),
        ),
      ),
    );
    // The totp row keeps the secret only. Its backup code column is unread from version 8 on.
    expect(totp?.backupCodes).toEqual([]);
  });

  it("lets a version 1 list of 8 characters pass until it is replaced, and the replacement writes version 2", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    const [factor] = await auth.storage.findMany("secondFactor", []);
    if (!factor) throw new Error("no factor row");
    // The list that migration 0008 copies from a plan 9f row: 8 characters, version 1.
    const old = "abcd2345";
    await auth.storage.update("secondFactor", [{ field: "id", op: "eq", value: factor.id }], {
      backupCodes: [await hmacSha256Hex(auth.config.secret, `${factor.id}:${old}`)],
      backupCodesVersion: 1,
    });
    expect(await totpStatus(auth.config, { userId: user.id })).toMatchObject({
      ok: true,
      value: { backupCodesLeft: 1, backupCodesVersion: 1 },
    });
    const r = await regenerateBackupCodesWithCode(auth.config, { user, code: old });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.backupCodes[0]).toMatch(GROUPED);
    expect(await totpStatus(auth.config, { userId: user.id })).toMatchObject({
      ok: true,
      value: { backupCodesLeft: 10, backupCodesVersion: 2 },
    });
    expect(await regenerateBackupCodesWithCode(auth.config, { user, code: old })).toMatchObject({
      code: "invalid_code",
    });
  });

  it("turns every method off at the in-process disable: the rows, the trusted devices, and the challenges go", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth);
    const at = auth.clock.now();
    await auth.storage.create("trustedDevice", {
      id: "d1",
      userId: user.id,
      tokenHash: "h-d1",
      expiresAt: new Date(at.getTime() + 60_000),
      lastSeenAt: at,
      createdAt: at,
      updatedAt: at,
    });
    await auth.storage.create("verification", {
      id: "c1",
      purpose: "two-factor",
      identifier: user.id,
      valueHash: "h-c1",
      expiresAt: new Date(at.getTime() + 60_000),
      consumedAt: null,
      data: { attempts: 0 },
      createdAt: at,
      updatedAt: at,
    });
    expect(await disableTotp(auth.config, { userId: user.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    for (const model of ["totp", "secondFactor", "trustedDevice"] as const)
      expect(
        await auth.storage.findMany(model, [{ field: "userId", op: "eq", value: user.id }]),
      ).toEqual([]);
    expect(
      await auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "two-factor" },
      ]),
    ).toEqual([]);
  });

  it("keeps a setup that is not confirmed when the in-process disable finds the factor off, and writes nothing", async () => {
    const auth = totpAuth();
    const { user } = await verifiedSession(auth);
    const setup = await setupTotp(auth.config, { userId: user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    const [before] = await auth.storage.findMany("totp", []);
    expect(await disableTotp(auth.config, { userId: user.id })).toMatchObject({
      code: "totp_not_enabled",
    });
    expect(await auth.storage.findMany("totp", [])).toEqual([before]);
  });
});
