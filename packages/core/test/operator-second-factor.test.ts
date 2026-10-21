import { describe, expect, it, vi } from "vitest";
import { defaultNoticeMail, type NoticeMailInput } from "../src/engine/notices.js";
import type { OperatorActor } from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import {
  type FactorProof,
  PROOF_MAX_AGE_MS,
  PROOF_METHODS,
} from "../src/engine/operator/second-factor.js";
import { passwordSignIn } from "../src/engine/password.js";
import { setupTotp } from "../src/engine/totp.js";
import type { StorageAdapter } from "../src/storage/port.js";
import {
  OPERATOR_SECRETS,
  type OperatorAuth,
  operatorAuth,
  operatorFixture,
  secretActor,
} from "./operator-helpers.js";
import { enrolled, PASSWORD, totpAuth, verifiedSession } from "./totp-helpers.js";

const APP: OperatorActor = { kind: "app", name: "support-tool" };
const EMAIL = "ada@example.com";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** The operator's own IP and user agent. Neither may reach the user's notice. */
const OPERATOR_IP = "203.0.113.9";
const OPERATOR_UA = "Support/1";

type Proof = { method: unknown; reference: unknown; checkedAt: unknown };

/** A proof of a document check `ageMs` before now, with the case id of the app. */
const proofAt = (auth: OperatorAuth, ageMs: number): Proof => ({
  method: "document",
  reference: "CASE-4821",
  checkedAt: new Date(auth.clock.now().getTime() - ageMs).toISOString(),
});

/** The disable by the app with a proof of 1 day ago. `extra` replaces a key of the input. */
function disable(auth: OperatorAuth, userId: string, extra: Record<string, unknown> = {}) {
  const input = {
    actor: APP,
    userId,
    reason: "Lost the phone; the passport was checked",
    proof: proofAt(auth, DAY_MS),
    ip: OPERATOR_IP,
    userAgent: OPERATOR_UA,
    ...extra,
  };
  return operatorApi(auth.config).secondFactor.disable(
    input as Parameters<ReturnType<typeof operatorApi>["secondFactor"]["disable"]>[0],
  );
}

/** The notice mails of `factor_disabled`, by the first line of the default text. */
const offMails = (auth: OperatorAuth) =>
  auth.mail.filter((m) => m.text.startsWith("A second factor was turned off"));

const auditRows = (auth: OperatorAuth) => auth.storage.findMany("operatorAudit", []);

const signIn = (auth: OperatorAuth) =>
  passwordSignIn(auth.config, { email: EMAIL, password: PASSWORD, ip: "9.9.9.9", userAgent: "ua" });

/**
 * The storage of the config with a count of each call, also inside a
 * transaction. The call of `transaction` itself does not count.
 */
function counted(storage: StorageAdapter) {
  let calls = 0;
  const wrap = (s: StorageAdapter): StorageAdapter =>
    new Proxy(s, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "transaction") {
            const [run] = args as [(tx: StorageAdapter) => Promise<unknown>];
            return value.call(target, (tx: StorageAdapter) => run(wrap(tx)));
          }
          calls += 1;
          return value.apply(target, args);
        };
      },
    });
  return {
    storage: wrap(storage),
    take: () => {
      const n = calls;
      calls = 0;
      return n;
    },
  };
}

describe("the disable of the second factor with a proof (plan 12f Task 9)", () => {
  it("turns the factor off with the proof in the row", async () => {
    const auth = await operatorAuth();
    const { user } = await enrolled(auth, EMAIL);
    const before = await signIn(auth);
    if (!before.ok) throw new Error(before.code);
    expect("twoFactor" in before.value).toBe(true);
    const proof = proofAt(auth, DAY_MS);
    const done = await disable(auth, user.id, { proof });
    if (!done.ok) throw new Error(done.code);
    const after = await signIn(auth);
    if (!after.ok) throw new Error(after.code);
    expect("token" in after.value).toBe(true);
    expect("twoFactor" in after.value).toBe(false);
    for (const model of ["totp", "secondFactor"] as const)
      expect(
        await auth.storage.findMany(model, [{ field: "userId", op: "eq", value: user.id }]),
      ).toEqual([]);
    // The challenge of the first sign-in went with the factor.
    expect(
      await auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "two-factor" },
      ]),
    ).toEqual([]);
    const rows = await auditRows(auth);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: done.value.auditId,
      actorKind: "app",
      actorId: "support-tool",
      action: "second_factor_disable",
      targetUserId: user.id,
      reason: "Lost the phone; the passport was checked",
      ip: OPERATOR_IP,
      userAgent: OPERATOR_UA,
    });
    expect(rows[0]?.data).toEqual({
      method: "document",
      reference: "CASE-4821",
      checkedAt: proof.checkedAt,
    });
  });

  it("refuses a proof older than seven days or in the future", async () => {
    const auth = await operatorAuth();
    const { user } = await enrolled(auth, EMAIL);
    expect(await disable(auth, user.id, { proof: proofAt(auth, 8 * DAY_MS) })).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(await disable(auth, user.id, { proof: proofAt(auth, -MINUTE_MS) })).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(await auditRows(auth)).toEqual([]);
    expect(offMails(auth)).toEqual([]);
    // The ends of the window pass: a check of exactly 7 days ago, and of now.
    expect(PROOF_MAX_AGE_MS).toBe(604_800_000);
    const oldest = await disable(auth, user.id, { proof: proofAt(auth, 7 * DAY_MS) });
    expect(oldest.ok).toBe(true);
    const again = await enrolled(auth, "bob@example.com");
    const now = await disable(auth, again.user.id, { proof: proofAt(auth, 0) });
    expect(now.ok).toBe(true);
  });

  it("refuses a method outside the list, a bad reference, and a date that does not exist", async () => {
    const auth = await operatorAuth();
    const { user } = await enrolled(auth, EMAIL);
    expect(PROOF_METHODS).toEqual(["document", "in_person", "video", "knowledge", "other"]);
    const good = proofAt(auth, DAY_MS);
    const bad: Proof[] = [
      { ...good, method: "selfie" },
      { ...good, method: undefined },
      { ...good, reference: "" },
      { ...good, reference: "x".repeat(201) },
      { ...good, reference: "CASE\n4821" },
      // A lone surrogate is no code point: Postgres refuses it in the jsonb
      // column, and memory and D1 keep it (plan 12f Task 9 review m2).
      { ...good, reference: "CASE-\ud800" },
      { ...good, reference: "\udc00CASE" },
      // The class of the user name (final review m5 of plan 12f): a bidi control and a separator.
      { ...good, reference: "CASE-\u202e4821" },
      { ...good, reference: "CASE\u20284821" },
      { ...good, reference: "CASE\u00854821" },
      { ...good, reference: 4821 },
      // Hour 24 does not exist. `Date` reads it as 00:00 of the next day,
      // which is inside the window here.
      { ...good, checkedAt: `${String(good.checkedAt).slice(0, 10)}T24:00:00.000Z` },
      { ...good, checkedAt: "yesterday" },
      { ...good, checkedAt: Date.parse(String(good.checkedAt)) },
    ];
    for (const proof of bad)
      expect(await disable(auth, user.id, { proof })).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    for (const proof of [undefined, null, "document"])
      expect(await disable(auth, user.id, { proof })).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    // The reason of the row takes the same rule.
    expect(await disable(auth, user.id, { reason: "Lost the phone \ud83d" })).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(await auditRows(auth)).toEqual([]);
    // The longest reference passes, with each method of the list.
    const done = await disable(auth, user.id, {
      proof: { ...good, method: "knowledge", reference: "x".repeat(200) },
    });
    expect(done.ok).toBe(true);
    // A whole surrogate pair is one code point, and it passes.
    const again = await enrolled(auth, "bob@example.com");
    const pair = await disable(auth, again.user.id, {
      reason: "Lost the phone \ud83d\udcf1",
      proof: { ...good, reference: "CASE-\ud83d\udcf1" },
    });
    expect(pair.ok).toBe(true);
    expect((await auditRows(auth)).at(-1)).toMatchObject({
      reason: "Lost the phone \ud83d\udcf1",
      data: { reference: "CASE-\ud83d\udcf1" },
    });
  });

  it("writes no row when the factor was off", async () => {
    const auth = await operatorAuth();
    const { user } = await verifiedSession(auth, EMAIL);
    // A setup that is not confirmed: the factor is off, and a totp row exists.
    const setup = await setupTotp(auth.config, { userId: user.id, password: PASSWORD });
    if (!setup.ok) throw new Error(setup.code);
    const [pending] = await auth.storage.findMany("totp", []);
    expect(pending).toBeDefined();
    expect(await disable(auth, user.id)).toMatchObject({ ok: false, code: "totp_not_enabled" });
    expect(await auditRows(auth)).toEqual([]);
    expect(offMails(auth)).toEqual([]);
    // The undo of the transaction keeps the setup in progress.
    expect(await auth.storage.findMany("totp", [])).toEqual([pending]);
  });

  it("mails the notice with no operator address", async () => {
    const auth = await operatorAuth();
    const { user } = await enrolled(auth, EMAIL);
    const done = await disable(auth, user.id);
    if (!done.ok) throw new Error(done.code);
    const mails = offMails(auth);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe(EMAIL);
    expect(mails[0]?.text).not.toContain(OPERATOR_IP);
    expect(mails[0]?.text).not.toContain("IP address");
    expect(mails[0]?.text).not.toContain(OPERATOR_UA);
  });

  it("hands the notice builder no IP and no user agent, and sends no notice with notices: false", async () => {
    const mail = vi.fn((input: NoticeMailInput) => defaultNoticeMail(input));
    const auth = await operatorAuth({ account: { notices: { mail } } });
    const { user } = await enrolled(auth, EMAIL);
    mail.mockClear();
    const done = await disable(auth, user.id);
    if (!done.ok) throw new Error(done.code);
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls[0]?.[0]).toMatchObject({
      event: "factor_disabled",
      email: EMAIL,
      ip: null,
      userAgent: null,
    });
    // With the notices off the act still runs, and no notice goes.
    const off = await operatorAuth({ account: { notices: false } });
    const ada = await enrolled(off, EMAIL);
    const quiet = await disable(off, ada.user.id);
    if (!quiet.ok) throw new Error(quiet.code);
    expect(offMails(off)).toEqual([]);
    expect((await auditRows(off)).map((r) => r.action)).toEqual(["second_factor_disable"]);
  });

  it("writes only the three proof keys, and the time in the toISOString form", async () => {
    const auth = await operatorAuth();
    const { user } = await enrolled(auth, EMAIL);
    const at = new Date(auth.clock.now().getTime() - DAY_MS);
    // The same instant, written with the zone +02:00.
    const local = new Date(at.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 23);
    const proof = {
      method: "document",
      reference: "CASE-4821",
      checkedAt: `${local}+02:00`,
      document: "P1234567",
    };
    const done = await disable(auth, user.id, { proof });
    if (!done.ok) throw new Error(done.code);
    const [row] = await auditRows(auth);
    expect(row?.data).toEqual({
      method: "document",
      reference: "CASE-4821",
      checkedAt: at.toISOString(),
    });
    expect(JSON.stringify(row)).not.toContain("P1234567");
  });

  it("answers not_found while the user tools are off, after the actor check", async () => {
    const auth = totpAuth();
    const { user } = await enrolled(auth, EMAIL);
    const api = operatorApi(auth.config);
    const input = {
      userId: user.id,
      reason: "Lost the phone",
      proof: { method: "document", reference: "CASE-1", checkedAt: auth.clock.now().toISOString() },
      ip: null,
      userAgent: null,
    } as const;
    expect(await api.secondFactor.disable({ actor: APP, ...input })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      await api.secondFactor.disable({ actor: { kind: "app", name: "Bad Name\r\n" }, ...input }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });

  it("refuses a secret with no users scope, and a user actor on their own user or on a platform operator", async () => {
    const { auth, operator } = await operatorFixture();
    const { user } = await enrolled(auth, EMAIL);
    const auditOnly = await secretActor(auth, OPERATOR_SECRETS.audit);
    expect(await disable(auth, user.id, { actor: auditOnly })).toMatchObject({
      ok: false,
      code: "operator_required",
    });
    const actor: OperatorActor = { kind: "user", user: operator.user, session: operator.session };
    expect(await disable(auth, operator.user.id, { actor })).toMatchObject({
      ok: false,
      code: "operator_self",
    });
    const granted = await operatorApi(auth.config).platformRole.grant({
      actor: APP,
      userId: user.id,
      reason: "New support hire",
      ip: null,
      userAgent: null,
    });
    if (!granted.ok) throw new Error(granted.code);
    expect(await disable(auth, user.id, { actor })).toMatchObject({
      ok: false,
      code: "operator_required",
    });
    expect((await auditRows(auth)).map((r) => r.action)).toEqual(["platform_role_grant"]);
    // A secret with the scope can act on a platform operator (spec 26 item 1).
    const support = await secretActor(auth, OPERATOR_SECRETS.support);
    const done = await disable(auth, user.id, { actor: support });
    if (!done.ok) throw new Error(done.code);
    expect((await auditRows(auth)).map((r) => [r.action, r.actorKind, r.actorId])).toEqual([
      ["platform_role_grant", "app", "support-tool"],
      ["second_factor_disable", "secret", "support"],
    ]);
  });

  it("costs a fixed count of storage calls", async () => {
    const { auth, operator } = await operatorFixture();
    const ada = await enrolled(auth, EMAIL);
    const bob = await enrolled(auth, "bob@example.com");
    const count = counted(auth.storage);
    const api = operatorApi({ ...auth.config, storage: count.storage });
    const input = {
      reason: "Lost the phone",
      proof: proofAt(auth, DAY_MS) as FactorProof,
      ip: null,
      userAgent: null,
    };
    count.take();
    const byApp = await api.secondFactor.disable({ actor: APP, userId: ada.user.id, ...input });
    if (!byApp.ok) throw new Error(byApp.code);
    // The user read, the hold of the user row (a read and an update), four
    // deletes, and the audit insert.
    expect(count.take()).toBe(8);
    const actor: OperatorActor = { kind: "user", user: operator.user, session: operator.session };
    const byUser = await api.secondFactor.disable({ actor, userId: bob.user.id, ...input });
    if (!byUser.ok) throw new Error(byUser.code);
    // Two more reads: the platform organization and the member row of the target.
    expect(count.take()).toBe(10);
  });
});
