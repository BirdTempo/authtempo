import { describe, expect, it } from "vitest";
import { createAuth } from "../create-auth.js";
import { sha256Base64Url, sha256Hex } from "../primitives/crypto.js";
import { createPbkdf2PasswordHash } from "../seams/password-hash.js";
import type { ConformanceTarget } from "./conformance.js";
import type { StorageAdapter } from "./port.js";

/**
 * The race of a detected refresh reuse (ruling 40 of plan 12e) on one
 * storage. Two parallel requests spend one refresh row: the winner writes a
 * new row, and the loser ends the family. A gate fixes the order that
 * Postgres READ COMMITTED allows. The loser's family DELETE runs in a
 * transaction that commits only after the winner answers, so the DELETE
 * cannot see the winner's new row. This is how one slow DELETE statement
 * behaves. After the reuse answer, no row of the family may be live.
 * Memory and D1 have no such isolation, so there the gate only fixes the
 * order.
 *
 * The second suite holds a grant revoke and a password reset beside a
 * refresh in flight (ruling 43 of plan 12e). The refresh spends its row.
 * The revoke's DELETE runs in its transaction. The refresh writes its new
 * row and still sees its spent row. Then the revoke commits. After the
 * revoke answers, no row of the family may be live.
 *
 * Call it from an adapter's test file with a factory that opens a fresh
 * database.
 */
export function runRefreshRaceConformance(
  name: string,
  factory: () => Promise<ConformanceTarget>,
): void {
  describe(`refresh reuse race: ${name}`, () => {
    for (const scenario of SCENARIOS)
      it(scenario.title, async () => {
        const target = await factory();
        try {
          await raceRun(target.adapter, scenario);
        } finally {
          await target.close();
        }
      });
  });
  describe(`refresh revoke race: ${name}`, () => {
    for (const scenario of REVOKES)
      it(scenario.title, async () => {
        const target = await factory();
        try {
          await revokeRun(target.adapter, scenario);
        } finally {
          await target.close();
        }
      });
  });
}

const BASE = "https://api.example.com";
const REDIRECT = "https://client.example.com/callback";
const RESOURCE = `${BASE}/mcp`;
/** The longest wait of a gate. A run that never meets the gated event goes on after it. */
const GATE_MS = 2000;

type Answer = { status: number; body: Record<string, unknown> };
type Auth = ReturnType<typeof createAuth>;

interface Grant {
  clientId: string;
  token: string;
  familyId: string;
  userId: string;
}

interface World {
  /** A fresh grant: its client, its first refresh token, its family id, and its user. */
  grant(): Promise<Grant>;
  refresh(via: 0 | 1, clientId: string, token: string): Promise<Answer>;
  advance(ms: number): void;
  /** The two instances on one storage. */
  auths: readonly [Auth, Auth];
  /** The text of each mail, in order. */
  mail: string[];
}

interface RevokeScenario {
  title: string;
  /** The revoke, on instance 0, while the refresh is in flight. */
  revoke(w: World, g: Grant): Promise<unknown>;
}

const REVOKES: RevokeScenario[] = [
  {
    title: "a grant revoke beside a refresh in flight leaves no live row",
    revoke: async (w, g) => {
      const r = await w.auths[0].api.oauth?.revoke({ userId: g.userId, clientId: g.clientId });
      if (!r?.ok) throw new Error("refresh race: the grant revoke failed");
    },
  },
  {
    title: "a password reset beside a refresh in flight leaves no live row",
    revoke: async (w, g) => {
      const api = w.auths[0].api.password;
      await api?.requestReset({ email: "ada@example.com", ip: null });
      const token = /(pr_[A-Za-z0-9_-]{43})/.exec(w.mail.at(-1) ?? "")?.[1] ?? "";
      const r = await api?.reset({
        token,
        password: "a new and long passphrase",
        ip: null,
        userAgent: null,
      });
      if (!r?.ok) throw new Error(`refresh race: the reset failed (${g.userId})`);
    },
  },
];

interface Scenario {
  title: string;
  window: number;
  /** The setup, then the tokens of the two parallel requests: the first on instance 0, the second on instance 1. */
  setup(w: World, g: { clientId: string; token: string }): Promise<[string, string]>;
}

const SCENARIOS: Scenario[] = [
  {
    title: "two parallel refreshes of one token leave no live row after the reuse (plan 9g path)",
    window: 0,
    setup: async (_w, g) => [g.token, g.token],
  },
  {
    title:
      "a retry inside the window beside a refresh of the child leaves no live row after the reuse",
    window: 10,
    setup: async (w, g) => {
      const child = String((await w.refresh(0, g.clientId, g.token)).body.refresh_token);
      w.advance(2000);
      return [g.token, child];
    },
  },
  {
    title: "two parallel retries inside the window leave no live row after the reuse",
    window: 10,
    setup: async (w, g) => {
      await w.refresh(0, g.clientId, g.token);
      w.advance(2000);
      return [g.token, g.token];
    },
  },
];

/** A promise and its resolve. */
function signal() {
  let resolve = () => {};
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  return { done, resolve };
}

const timeout = () => new Promise((r) => setTimeout(r, GATE_MS));

/**
 * A storage that, while armed, holds the `oauthToken` events in one order.
 * Both spends start together. The loser's family DELETE runs in a
 * transaction. The winner's new row waits for that DELETE. The transaction
 * commits after `commitAfter` settles.
 */
function gated(base: StorageAdapter) {
  let armed = false;
  let updates = 0;
  const bothUpdate = signal();
  const deleteRan = signal();
  let commitAfter: Promise<unknown> = Promise.resolve();
  const storage: StorageAdapter = {
    create: async (model, data) => {
      if (armed && model === "oauthToken") await Promise.race([deleteRan.done, timeout()]);
      return base.create(model, data);
    },
    createMany: (model, rows) => base.createMany(model, rows),
    rowsPerInsert: (model) => base.rowsPerInsert(model),
    findOne: (model, where) => base.findOne(model, where),
    findMany: (model, where, opts) => base.findMany(model, where, opts),
    update: async (model, where, data) => {
      if (armed && model === "oauthToken") {
        if (++updates === 2) bothUpdate.resolve();
        await Promise.race([bothUpdate.done, timeout()]);
      }
      return base.update(model, where, data);
    },
    delete: async (model, where) => {
      if (!(armed && model === "oauthToken" && where.some((w) => w.field === "familyId")))
        return base.delete(model, where);
      return base.transaction(async (tx) => {
        const n = await tx.delete(model, where);
        deleteRan.resolve();
        await Promise.race([commitAfter, timeout()]);
        return n;
      });
    },
    deleteRows: (model, where) => base.deleteRows(model, where),
    isolated: base.isolated,
    keep: () => base.keep(),
    transaction: (fn) => base.transaction(fn),
  };
  return {
    storage,
    arm(after: Promise<unknown>) {
      armed = true;
      commitAfter = after;
    },
    disarm() {
      armed = false;
    },
  };
}

/**
 * A storage that, while armed, holds the events of a refresh beside a
 * revoke. The refresh's spend signals `spent`. The `oauthToken` DELETE in
 * a transaction signals `deleted`, then holds its transaction open until
 * `commitAfter` settles. The refresh's new row waits for that DELETE.
 */
function revokeGated(base: StorageAdapter) {
  let armed = false;
  const spent = signal();
  const deleted = signal();
  let commitAfter: Promise<unknown> = Promise.resolve();
  const inTx = (tx: StorageAdapter): StorageAdapter => ({
    create: (model, data) => tx.create(model, data),
    createMany: (model, rows) => tx.createMany(model, rows),
    rowsPerInsert: (model) => tx.rowsPerInsert(model),
    findOne: (model, where) => tx.findOne(model, where),
    findMany: (model, where, opts) => tx.findMany(model, where, opts),
    update: (model, where, data) => tx.update(model, where, data),
    delete: async (model, where) => {
      const n = await tx.delete(model, where);
      if (armed && model === "oauthToken") {
        deleted.resolve();
        await Promise.race([commitAfter, timeout()]);
      }
      return n;
    },
    deleteRows: (model, where) => tx.deleteRows(model, where),
    isolated: tx.isolated,
    keep: () => tx.keep(),
    transaction: (fn) => tx.transaction((inner) => fn(inTx(inner))),
  });
  const storage: StorageAdapter = {
    create: async (model, data) => {
      if (armed && model === "oauthToken") await Promise.race([deleted.done, timeout()]);
      return base.create(model, data);
    },
    createMany: (model, rows) => base.createMany(model, rows),
    rowsPerInsert: (model) => base.rowsPerInsert(model),
    findOne: (model, where) => base.findOne(model, where),
    findMany: (model, where, opts) => base.findMany(model, where, opts),
    update: async (model, where, data) => {
      const n = await base.update(model, where, data);
      if (armed && model === "oauthToken") spent.resolve();
      return n;
    },
    delete: (model, where) => base.delete(model, where),
    deleteRows: (model, where) => base.deleteRows(model, where),
    isolated: base.isolated,
    keep: () => base.keep(),
    transaction: (fn) => base.transaction((tx) => fn(inTx(tx))),
  };
  return {
    storage,
    spent: spent.done,
    arm(after: Promise<unknown>) {
      armed = true;
      commitAfter = after;
    },
    disarm() {
      armed = false;
    },
  };
}

async function revokeRun(base: StorageAdapter, scenario: RevokeScenario): Promise<void> {
  const gate = revokeGated(base);
  const world = openWorld(base, gate.storage, 0);
  const g = await world.grant();
  const answered = signal();
  gate.arm(answered.done);
  const refresh = world.refresh(1, g.clientId, g.token);
  void refresh.then(answered.resolve, answered.resolve);
  // The revoke starts after the refresh spent its row, the reviewer's order.
  await Promise.race([gate.spent, timeout()]);
  const [answer] = await Promise.all([refresh, scenario.revoke(world, g)]);
  gate.disarm();
  const live = await base.findMany("oauthToken", [
    { field: "familyId", op: "eq", value: g.familyId },
    { field: "usedAt", op: "eq", value: null },
  ]);
  expect(live).toEqual([]);
  if (answer.status === 200)
    expect(await world.refresh(0, g.clientId, String(answer.body.refresh_token))).toEqual({
      status: 400,
      body: { error: "invalid_grant" },
    });
}

async function raceRun(base: StorageAdapter, scenario: Scenario): Promise<void> {
  const gate = gated(base);
  const world = openWorld(base, gate.storage, scenario.window);
  const g = await world.grant();
  const [t0, t1] = await scenario.setup(world, g);
  // The loser's DELETE commits after the first answer, which is the winner's.
  const firstAnswer = signal();
  gate.arm(firstAnswer.done);
  const requests = [world.refresh(0, g.clientId, t0), world.refresh(1, g.clientId, t1)];
  void Promise.race(requests).then(firstAnswer.resolve, firstAnswer.resolve);
  const answers = await Promise.all(requests);
  gate.disarm();
  const reuse = { status: 400, body: { error: "invalid_grant" } };
  expect(answers).toContainEqual(reuse);
  const live = await base.findMany("oauthToken", [
    { field: "familyId", op: "eq", value: g.familyId },
    { field: "usedAt", op: "eq", value: null },
  ]);
  expect(live).toEqual([]);
  for (const a of answers)
    if (a.status === 200)
      expect(await world.refresh(0, g.clientId, String(a.body.refresh_token))).toEqual(reuse);
}

/** Two core instances on `storage`, with a reuse window of `window` seconds. `base` reads rows past the gate. */
function openWorld(base: StorageAdapter, storage: StorageAdapter, window: number): World {
  let t = Date.parse("2026-10-20T00:00:00.000Z");
  const clock = { now: () => new Date(t) };
  const mail: string[] = [];
  const instance = () =>
    createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage,
      // Every request passes: the race, not the limit, is under test.
      limiter: { allow: async () => true },
      clock,
      mail: {
        send: async (m) => {
          mail.push(m.text);
        },
      },
      oauth: {
        resources: [RESOURCE],
        registration: { cimd: false, dynamic: true },
        refreshReuseSeconds: window,
      },
      // A fast hash: the race, not the hash, is under test.
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    });
  // Two instances on one storage.
  const auths = [instance(), instance()] as const;
  const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    auths[0].handle(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const form = (via: 0 | 1, path: string, body: Record<string, string>, cookie?: string) =>
    auths[via].handle(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(cookie !== undefined ? { origin: BASE, cookie } : {}),
        },
        body: new URLSearchParams(body).toString(),
      }),
    );
  const rowOf = async (token: string) =>
    base.findOne("oauthToken", [{ field: "tokenHash", op: "eq", value: await sha256Hex(token) }]);
  return {
    auths,
    mail,
    async grant() {
      const reg = await json("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        client_name: "Race client",
      });
      const clientId = String(((await reg.json()) as { client_id: unknown }).client_id);
      await json("/auth/magic-link/request", { email: "ada@example.com" });
      const link = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "";
      const verified = await json("/auth/magic-link/verify", { token: link });
      const cookie = (verified.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const verifier = "v".repeat(43);
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
        scope: "openid offline_access",
        resource: RESOURCE,
        state: "s",
      });
      const page = await auths[0].handle(
        new Request(`${BASE}/auth/oauth/authorize?${query}`, { headers: { cookie } }),
      );
      const requestId = /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(
        await page.text(),
      )?.[1];
      if (!requestId) throw new Error(`refresh race: no consent page (${page.status})`);
      const allowed = await form(
        0,
        "/auth/oauth/authorize",
        { request_id: requestId, decision: "allow" },
        cookie,
      );
      const code = new URL(allowed.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const issued = await form(0, "/auth/oauth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: RESOURCE,
      });
      const token = String(((await issued.json()) as { refresh_token: unknown }).refresh_token);
      const row = await rowOf(token);
      if (!row) throw new Error(`refresh race: no refresh row (${issued.status})`);
      return { clientId, token, familyId: row.familyId, userId: row.userId };
    },
    async refresh(via, clientId, token) {
      const res = await form(via, "/auth/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: clientId,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    advance(ms) {
      t += ms;
    },
  };
}
