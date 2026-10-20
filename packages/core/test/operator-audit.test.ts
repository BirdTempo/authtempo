import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { ConfigError } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { deleteFamilies } from "../src/engine/oauth-family.js";
import {
  auditDraft,
  listAudit,
  type OperatorAuditDraft,
  operatorAct,
  operatorReason,
  REASON_MAX,
} from "../src/engine/operator/audit.js";
import { matchOperatorSecret, type OperatorActor } from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { hasControlChar } from "../src/primitives/text.js";
import { fail, ok } from "../src/result.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { BASE_URL, makeAuth } from "./helpers.js";
import {
  OPERATOR_SECRETS,
  type OperatorAuth,
  operatorAuth,
  operatorHeader,
} from "./operator-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const TARGET = "target@example.com";
/** A named secret of the form of `isOperatorSecret`, for the secret actor `ci`. */
const CI_SECRET = "operator-ci-0123456789abcdef-0123456789";

/** The secret actor of a request with the named secret, as the routes build it. */
async function secretActor(auth: OperatorAuth, secret: string): Promise<OperatorActor> {
  const request = new Request(`${BASE_URL}/auth/operator/audit`, {
    headers: operatorHeader(secret),
  });
  const entry = await matchOperatorSecret(auth.config, request);
  if (!entry) throw new Error("no secret matched");
  return { kind: "secret", name: entry.name, scopes: entry.scopes };
}

const APP: OperatorActor = { kind: "app", name: "support-tool" };

/** The draft of `auditDraft`, or a throw for a refused actor. */
function draftOf(
  actor: OperatorActor,
  input: Parameters<typeof auditDraft>[1],
): OperatorAuditDraft {
  const draft = auditDraft(actor, input);
  if (!draft.ok) throw new Error(draft.code);
  return draft.value;
}

/** A draft of a ban by the app, as the acts of Tasks 6 to 9 build one. */
function draftFor(targetUserId: string, actor: OperatorActor = APP): OperatorAuditDraft {
  return draftOf(actor, {
    action: "ban",
    targetUserId,
    reason: "Spam from this account.",
    data: { until: null },
    ip: "203.0.113.7",
    userAgent: "curl/8.9",
  });
}

/**
 * The work of the test: the profile update of plan 12a, a change of the
 * user's name. `answer` decides what the work answers after the write.
 */
function rename(userId: string, name: string, answer: "ok" | "fail" | "throw" = "ok") {
  return async (tx: StorageAdapter) => {
    await tx.update("user", [{ field: "id", op: "eq", value: userId }], { name });
    if (answer === "fail") return fail<{ renamed: true }>("conflict");
    if (answer === "throw") throw new Error("the work broke");
    return ok({ renamed: true as const });
  };
}

async function nameOf(storage: StorageAdapter, userId: string) {
  return (await storage.findOne("user", [{ field: "id", op: "eq", value: userId }]))?.name ?? null;
}

const auditRows = (storage: StorageAdapter) => storage.findMany("operatorAudit", []);

/**
 * A memory store whose `create` of `operatorAudit` throws, inside a
 * transaction and outside it. Every other call passes to the store.
 */
function auditCreateFails(inner: StorageAdapter): StorageAdapter {
  const wrap = (s: StorageAdapter): StorageAdapter => ({
    create: (model, data) => {
      if (model === "operatorAudit") throw new Error("the audit insert failed");
      return s.create(model, data);
    },
    findOne: (model, where) => s.findOne(model, where),
    findMany: (model, where, opts) => s.findMany(model, where, opts),
    update: (model, where, data) => s.update(model, where, data),
    delete: (model, where) => s.delete(model, where),
    transaction: (fn) => s.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(inner);
}

describe("the operator audit row (plan 12f Task 4)", () => {
  it("writes the row inside the transaction, and no row when the act does not commit", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let refuse = false;
    let afterThrows = false;
    const seen: unknown[] = [];
    const auth = await operatorAuth({
      hooks: {
        operator: {
          beforeAction() {
            if (refuse) throw hookRefusal("no");
          },
          afterAction(e) {
            seen.push(e.audit);
            if (afterThrows) throw new Error("the copy to the other system failed");
          },
        },
      },
    });
    const { user } = await verifiedSession(auth, TARGET);
    const draft = draftFor(user.id);

    // A work that answers ok: the change and one row with every field of the draft.
    const done = await operatorAct(auth.config, draft, rename(user.id, "Ada"));
    if (!done.ok) throw new Error(done.code);
    expect(done.value.renamed).toBe(true);
    expect(await nameOf(auth.storage, user.id)).toBe("Ada");
    const [row, ...more] = await auditRows(auth.storage);
    expect(more).toEqual([]);
    expect(row).toEqual({
      id: done.value.auditId,
      createdAt: auth.clock.now(),
      updatedAt: auth.clock.now(),
      actorKind: "app",
      actorId: "support-tool",
      action: "ban",
      targetUserId: user.id,
      reason: "Spam from this account.",
      data: { until: null },
      ip: "203.0.113.7",
      userAgent: "curl/8.9",
    });
    // afterAction gets the stored row once, after the commit.
    expect(seen).toEqual([row]);

    // A work that answers an error: no change and no row.
    expect(await operatorAct(auth.config, draft, rename(user.id, "Bea", "fail"))).toEqual({
      ok: false,
      code: "conflict",
      status: 409,
    });
    // A work that throws: no change and no row, and the throw passes.
    await expect(operatorAct(auth.config, draft, rename(user.id, "Cy", "throw"))).rejects.toThrow(
      "the work broke",
    );
    // A refusal of beforeAction: hook_refused with the message, no change and no row.
    refuse = true;
    expect(await operatorAct(auth.config, draft, rename(user.id, "Di"))).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "no",
    });
    refuse = false;
    expect(await nameOf(auth.storage, user.id)).toBe("Ada");
    expect(await auditRows(auth.storage)).toHaveLength(1);
    expect(seen).toHaveLength(1);

    // An afterAction that throws: the change and the row stay, with one log line.
    afterThrows = true;
    const kept = await operatorAct(auth.config, draft, rename(user.id, "Eve"));
    if (!kept.ok) throw new Error(kept.code);
    expect(await nameOf(auth.storage, user.id)).toBe("Eve");
    expect((await auditRows(auth.storage)).map((r) => r.id)).toContain(kept.value.auditId);
    const lines = errors.mock.calls.filter((c) => c[0] === "authtempo: after hook failed");
    expect(lines).toEqual([
      ["authtempo: after hook failed", "operator.afterAction", kept.value.auditId, "Error"],
    ]);
  });

  it("keeps the act when the audit insert fails out: the row and the change share one transaction", async () => {
    const auth = await operatorAuth();
    const { user } = await verifiedSession(auth, TARGET);
    // The act runs on a view of the same store, as d1-like.ts builds one.
    const failing = { ...auth.config, storage: auditCreateFails(auth.storage) };
    await expect(operatorAct(failing, draftFor(user.id), rename(user.id, "Ada"))).rejects.toThrow(
      "the audit insert failed",
    );
    expect(await nameOf(auth.storage, user.id)).toBeNull();
    expect(await auditRows(auth.storage)).toEqual([]);
  });

  it("runs the steps after the commit in the order of ruling 2: the act's step, afterAction, then endFamilies", async () => {
    const order: string[] = [];
    const auth = await operatorAuth({
      hooks: {
        operator: {
          afterAction() {
            order.push("afterAction");
          },
        },
      },
    });
    const { user } = await verifiedSession(auth, TARGET);
    const inner = auth.storage;
    // endFamilies reads each noted scope again on the store, after the
    // commit. The reads inside the transaction go through its own tx.
    const recording: StorageAdapter = {
      create: (model, data) => inner.create(model, data),
      findOne: (model, where) => inner.findOne(model, where),
      findMany: (model, where, opts) => {
        if (model === "oauthToken") order.push("endFamilies");
        return inner.findMany(model, where, opts);
      },
      update: (model, where, data) => inner.update(model, where, data),
      delete: (model, where) => inner.delete(model, where),
      transaction: (fn) => inner.transaction(fn),
    };
    const done = await operatorAct(
      { ...auth.config, storage: recording },
      draftFor(user.id),
      async (tx, _draft, ends) => {
        await deleteFamilies(tx, [{ field: "userId", op: "eq", value: user.id }], ends.families);
        return ok({ userId: user.id });
      },
      {
        async committed(value) {
          expect(value.userId).toBe(user.id);
          order.push("committed");
        },
      },
    );
    expect(done.ok).toBe(true);
    expect(order).toEqual(["committed", "afterAction", "endFamilies"]);
  });

  it("runs afterAction and endFamilies when the act's step throws, with one log line", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    const auth = await operatorAuth({
      hooks: {
        operator: {
          afterAction() {
            order.push("afterAction");
          },
        },
      },
    });
    const { user } = await verifiedSession(auth, TARGET);
    const inner = auth.storage;
    const recording: StorageAdapter = {
      create: (model, data) => inner.create(model, data),
      findOne: (model, where) => inner.findOne(model, where),
      findMany: (model, where, opts) => {
        if (model === "oauthToken") order.push("endFamilies");
        return inner.findMany(model, where, opts);
      },
      update: (model, where, data) => inner.update(model, where, data),
      delete: (model, where) => inner.delete(model, where),
      transaction: (fn) => inner.transaction(fn),
    };
    const done = await operatorAct(
      { ...auth.config, storage: recording },
      draftFor(user.id),
      async (tx, _draft, ends) => {
        await deleteFamilies(tx, [{ field: "userId", op: "eq", value: user.id }], ends.families);
        return ok({ userId: user.id });
      },
      {
        async committed() {
          order.push("committed");
          throw new Error("step broke");
        },
      },
    );
    // The act is committed, so the answer is ok and the row stays.
    if (!done.ok) throw new Error(done.code);
    expect((await auditRows(auth.storage)).map((r) => r.id)).toEqual([done.value.auditId]);
    expect(order).toEqual(["committed", "afterAction", "endFamilies"]);
    expect(errors.mock.calls).toEqual([
      ["authtempo: operator step failed", done.value.auditId, "Error"],
    ]);
  });

  it("refuses a reason with a control character", () => {
    for (const raw of ["a\nb", "a\u0000", "", "x".repeat(REASON_MAX + 1), 7, null, undefined])
      expect(operatorReason(raw)).toEqual({ ok: false, code: "invalid_body", status: 400 });
    expect(operatorReason("x".repeat(500))).toEqual({ ok: true, value: "x".repeat(500) });
    // No trim: the reason is kept as the operator wrote it.
    expect(operatorReason(" Spam. ")).toEqual({ ok: true, value: " Spam. " });
  });

  it("refuses an act whose reason fails operatorReason before beforeAction: 400, no change, no row (spec 26 item 5)", async () => {
    let before = 0;
    const auth = await operatorAuth({
      hooks: {
        operator: {
          beforeAction() {
            before++;
          },
        },
      },
    });
    const { user } = await verifiedSession(auth, TARGET);
    const draft = { ...draftFor(user.id), reason: "a\nb" };
    expect(await operatorAct(auth.config, draft, rename(user.id, "Ada"))).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
    expect(await nameOf(auth.storage, user.id)).toBeNull();
    expect(await auditRows(auth.storage)).toEqual([]);
    expect(before).toBe(0);
  });

  it("writes no secret and no control character in the row", async () => {
    const auth = await operatorAuth({
      operator: {
        secrets: [{ name: "ci", secretHash: await sha256Hex(CI_SECRET), scopes: ["users"] }],
        users: true,
      },
    });
    const { user } = await verifiedSession(auth, TARGET);
    const actor = await secretActor(auth, CI_SECRET);
    const agent = `Mozilla/5.0\r\n${"a".repeat(587)}`;
    expect(agent).toHaveLength(600);
    const draft = draftOf(actor, {
      action: "ban",
      targetUserId: user.id,
      reason: "Spam.",
      data: null,
      ip: null,
      userAgent: agent,
    });
    const done = await operatorAct(auth.config, draft, rename(user.id, "Ada"));
    if (!done.ok) throw new Error(done.code);
    const [row] = await auditRows(auth.storage);
    expect(row?.actorKind).toBe("secret");
    expect(row?.actorId).toBe("ci");
    expect(row?.userAgent).toHaveLength(512);
    expect(row?.userAgent).toBe(`Mozilla/5.0${"a".repeat(501)}`);
    expect(hasControlChar(row?.userAgent ?? "\n")).toBe(false);
    const text = JSON.stringify(row);
    expect(text).not.toContain(CI_SECRET);
    expect(text).not.toContain(await sha256Hex(CI_SECRET));
  });

  it("names a secret actor by its name, a user actor by the user id, and the app by its name", async () => {
    const ci = { kind: "secret", name: "ci", scopes: ["users"] } as const;
    const auth = await operatorAuth();
    const operator = await verifiedSession(auth, "op@example.com");
    const input = {
      action: "ban",
      targetUserId: "u1",
      reason: "r",
      data: null,
      ip: null,
      userAgent: null,
    } as const;
    expect(draftOf(ci, input)).toMatchObject({ actorKind: "secret", actorId: "ci" });
    expect(
      draftOf({ kind: "user", user: operator.user, session: operator.session }, input),
    ).toMatchObject({ actorKind: "user", actorId: operator.user.id });
    expect(draftOf(APP, input)).toMatchObject({ actorKind: "app", actorId: "support-tool" });
  });

  it("pages the rows by id", async () => {
    const auth = await operatorAuth();
    const { user } = await verifiedSession(auth, TARGET);
    const other = await verifiedSession(auth, "other@example.com");
    for (let i = 0; i < 120; i++) {
      auth.clock.advance(1);
      const done = await operatorAct(auth.config, draftFor(user.id), rename(user.id, `n${i}`));
      if (!done.ok) throw new Error(done.code);
    }
    // A row of another target stays out of the pages.
    await operatorAct(auth.config, draftFor(other.user.id), rename(other.user.id, "x"));
    const api = operatorApi(auth.config);
    const actor = await secretActor(auth, OPERATOR_SECRETS.audit);
    const sizes: number[] = [];
    const ids: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 3; page++) {
      const read = await api.audit.list({
        actor,
        targetUserId: user.id,
        ...(after === null ? {} : { after }),
      });
      if (!read.ok) throw new Error(read.code);
      sizes.push(read.value.rows.length);
      ids.push(...read.value.rows.map((r) => r.id));
      after = read.value.next;
      if (page < 2) expect(after).toBe(read.value.rows.at(-1)?.id);
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(after).toBeNull();
    expect(new Set(ids).size).toBe(120);
    expect(ids).toEqual([...ids].sort());
    // With no target, the read holds every row.
    const all = await listAudit(auth.config, { actor, limit: 100 });
    if (!all.ok) throw new Error(all.code);
    expect(all.value.rows).toHaveLength(100);
    expect(all.value.next).toBe(all.value.rows.at(-1)?.id);
  });

  it("needs the audit scope and a limit from 1 to 100, and is off unless operator.users is on", async () => {
    const auth = await operatorAuth();
    const keys = await secretActor(auth, OPERATOR_SECRETS.keys);
    expect(await listAudit(auth.config, { actor: keys })).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    for (const limit of [0, 101, 1.5])
      expect(await listAudit(auth.config, { actor: APP, limit })).toEqual({
        ok: false,
        code: "invalid_body",
        status: 400,
      });
    expect(await listAudit(auth.config, { actor: APP, limit: 1 })).toEqual({
      ok: true,
      value: { rows: [], next: null },
    });
    const off = makeAuth();
    expect(await listAudit(off.config, { actor: APP })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });

  it("refuses an app name outside the rule at operatorApi, auditDraft, and listAudit (spec 26 item 1)", async () => {
    const name = `Ada@example.com\r\n${"x".repeat(283)}`;
    expect(name).toHaveLength(300);
    const bad: OperatorActor = { kind: "app", name };
    const refused = { ok: false, code: "invalid_body", status: 400 };
    // operatorApi checks the actor before the tool switch, so a deployment
    // with the tools off answers invalid_body, not not_found.
    expect(await operatorApi(makeAuth().config).audit.list({ actor: bad })).toEqual(refused);
    const auth = await operatorAuth();
    expect(await listAudit(auth.config, { actor: bad })).toEqual(refused);
    expect(
      auditDraft(bad, {
        action: "ban",
        targetUserId: "u1",
        reason: "r",
        data: null,
        ip: null,
        userAgent: null,
      }),
    ).toEqual(refused);
  });

  it("serves auth.api.operator.audit.list in every deployment", async () => {
    const input: AuthConfig = {
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [BASE_URL],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
    };
    expect(await createAuth(input).api.operator.audit.list({ actor: APP })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });
});

describe("hooks.operator in the config (plan 12f Task 4)", () => {
  it("refuses hooks.operator while operator.users is off, and a name that is no hook point", async () => {
    expect(() => makeAuth({ hooks: { operator: { afterAction() {} } } })).toThrow(
      new ConfigError("hooks.operator needs operator.users: the hooks would never run"),
    );
    await expect(operatorAuth({ hooks: { operator: { afterBan() {} } as never } })).rejects.toThrow(
      new ConfigError("hooks.operator.afterBan is not a hook point"),
    );
    const auth = await operatorAuth({ hooks: { operator: {} } });
    expect(auth.config.hooks.operator).toEqual({});
    expect(makeAuth().config.hooks.operator).toEqual({});
  });
});
