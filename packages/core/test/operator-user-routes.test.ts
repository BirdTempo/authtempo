import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { addMember, createOrganization } from "../src/engine/organizations.js";
import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteContract } from "../src/http/contract/types.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { post, recordCredential, settled } from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture, operatorHeader } from "./operator-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

// The operator routes of the update and the delete (plan 12f2 Task 5, spec
// 26). The create route belongs to the second wave of the plan (ruling 1 of
// plan 12f2, Q1). The users come from the sign-up flows.

beforeEach(() => {
  // The guard and the refusals write log lines; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A secret with the scopes `users` and `delete`. */
const ERASURE = recordCredential("operator-erasure-0123456789abcdef-0123");
/** A second secret with the scopes `users` and `delete`: its own count. */
const CLEANUP = recordCredential("operator-cleanup-0123456789abcdef-0123");
const WRONG = "operator-wrong-0123456789abcdef-0123456";
const IP = "203.0.113.70";
const AGENT = "ops-routes-test/1";
const REASON = "Ticket 4521";
const ADA = "ada@example.com";

const UPDATE = "POST /operator/users/update";
const DELETE = "POST /operator/users/delete";
type Key = typeof UPDATE | typeof DELETE;
const KEYS: readonly Key[] = [UPDATE, DELETE];

/** The contract table, read as a plain record. */
const CONTRACT: Record<string, RouteContract> = ROUTE_CONTRACT;

/**
 * The operator section of the world: `support` (`users`, `sessions`,
 * `audit`), `keys` (`keys`, `secrets`), `erasure` and `cleanup` (`users`,
 * `delete`), and with `users` the user tools and the impersonation.
 */
async function operatorSection(users = true): Promise<Pick<AuthConfig, "operator">> {
  return {
    operator: {
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(OPERATOR_SECRETS.support),
          scopes: ["users", "sessions", "audit"],
        },
        {
          name: "keys",
          secretHash: await sha256Hex(OPERATOR_SECRETS.keys),
          scopes: ["keys", "secrets"],
        },
        { name: "erasure", secretHash: await sha256Hex(ERASURE), scopes: ["users", "delete"] },
        { name: "cleanup", secretHash: await sha256Hex(CLEANUP), scopes: ["users", "delete"] },
      ],
      // The impersonation needs the user tools.
      ...(users ? { users: true, impersonation: {} } : {}),
    },
  };
}

/**
 * A platform operator from the flows (`operatorFixture`) with a fresh
 * session and TOTP on, the router of `createAuth` on the same config, and
 * a user `ada` from a sign-up.
 */
async function world(extra: Partial<AuthConfig> = {}, users = true) {
  const f = await operatorFixture({ config: { ...(await operatorSection(users)), ...extra } });
  const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
  const ada = await verifiedSession(f.auth, ADA);
  return {
    ...f,
    handle,
    ada: ada.user,
    operatorCookie: { cookie: `${f.auth.config.cookieName}=${f.operator.token}` },
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** One call of a route: a trusted JSON post with the IP and the agent. */
function call(w: World, key: Key, body: unknown, headers: Record<string, string>) {
  const path = key.slice("POST ".length);
  return w.handle(
    post(`/auth${path}`, body, { "cf-connecting-ip": IP, "user-agent": AGENT, ...headers }),
  );
}

/** What a route answered: the status, and the code of a JSON error. */
async function answerOf(res: Response): Promise<{ status: number; code: string | null }> {
  const body = (await res.clone().json()) as { error?: string };
  return { status: res.status, code: body.error ?? null };
}

/** A valid body of each route for `userId`. */
function bodyOf(key: Key, userId: string): Record<string, unknown> {
  return key === UPDATE ? { userId, name: "Ada L.", reason: REASON } : { userId, reason: REASON };
}

const userOf = (w: World, id: string) =>
  w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: id }]);

const auditRows = (w: World) =>
  w.auth.storage.findMany("operatorAudit", [], { sort: { field: "id", dir: "asc" } });

/** The JSON body of a 200, held to the route's contract: the parse succeeds and changes nothing. */
async function fitted(key: Key, res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  expect(res.status, `${key}: ${text}`).toBe(200);
  expect(res.headers.get("cache-control"), key).toBe("no-store");
  const body: unknown = JSON.parse(text);
  const answer = CONTRACT[key]?.answer;
  if (answer?.kind !== "json") throw new Error(`${key} has no JSON contract`);
  const parsed = answer.schema.safeParse(body);
  expect(parsed.success, `${key}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  expect(parsed.data, `${key}: the parse changed the answer`).toEqual(body);
  return body as Record<string, unknown>;
}

/** A solo organization of `user`, through the organization api. */
async function soloOrganization(w: World, user: UserRow, slug: string) {
  const made = await createOrganization(w.auth.config, { user, slug, name: slug });
  if (!made.ok) throw new Error(made.code);
  return made.value.organization;
}

describe("the operator update and delete routes (plan 12f2 Task 5)", () => {
  it("answers 404 for the two routes while operator.users is off", async () => {
    const w = await world({}, false);
    for (const key of KEYS)
      for (const headers of [operatorHeader(ERASURE), w.operatorCookie, {}]) {
        const res = await call(w, key, bodyOf(key, w.ada.id), headers);
        expect(await answerOf(res), key).toEqual({ status: 404, code: "not_found" });
        expect(res.headers.get("cache-control"), key).toBe("no-store");
      }
    expect(await userOf(w, w.ada.id)).toEqual(w.ada);
    expect(await auditRows(w)).toEqual([]);
  });

  it("refuses unknown keys", async () => {
    const w = await world();
    const before = await userOf(w, w.ada.id);
    const update = bodyOf(UPDATE, w.ada.id);
    const remove = bodyOf(DELETE, w.ada.id);
    const cases: [Key, Record<string, unknown>][] = [
      [UPDATE, { ...update, password: "correct horse battery" }],
      [UPDATE, { ...update, email: "ada.new@example.com" }],
      [UPDATE, { ...update, emailVerified: false }],
      [UPDATE, { ...update, role: "admin" }],
      [UPDATE, { ...update, banned: true }],
      [UPDATE, { ...update, banReason: "Spam" }],
      [UPDATE, { ...update, banUntil: "2026-02-01T00:00:00Z" }],
      [DELETE, { ...remove, password: "correct horse battery" }],
      [DELETE, { ...remove, email: ADA }],
      [DELETE, { ...remove, role: "admin" }],
      // No field to change, and a user id that is not a string.
      [UPDATE, { userId: w.ada.id, reason: REASON }],
      [DELETE, { userId: 7, reason: REASON }],
    ];
    for (const [key, body] of cases)
      for (const headers of [operatorHeader(ERASURE), w.operatorCookie]) {
        const res = await call(w, key, body, headers);
        expect(await answerOf(res), `${key} ${JSON.stringify(body)}`).toEqual({
          status: 400,
          code: "invalid_body",
        });
      }
    expect(await userOf(w, w.ada.id)).toEqual(before);
    expect(await auditRows(w)).toEqual([]);
  });

  it("needs the delete scope at the route", async () => {
    const w = await world();
    for (const secret of [OPERATOR_SECRETS.support, OPERATOR_SECRETS.keys]) {
      const res = await call(w, DELETE, bodyOf(DELETE, w.ada.id), operatorHeader(secret));
      expect(await answerOf(res), secret).toEqual({ status: 403, code: "operator_required" });
    }
    expect(await userOf(w, w.ada.id)).toEqual(w.ada);
    expect(await auditRows(w)).toEqual([]);
    // The scope users serves the update; the scope delete serves the delete.
    const support = operatorHeader(OPERATOR_SECRETS.support);
    expect((await call(w, UPDATE, bodyOf(UPDATE, w.ada.id), support)).status).toBe(200);
    const erasure = operatorHeader(ERASURE);
    expect((await call(w, DELETE, bodyOf(DELETE, w.ada.id), erasure)).status).toBe(200);
    expect(await userOf(w, w.ada.id)).toBeNull();
  });

  it("counts deletes per actor", async () => {
    const w = await world();
    const support = operatorHeader(OPERATOR_SECRETS.support);
    // A bad body counts first: the limit runs before the body read.
    const bad = await call(w, DELETE, { userId: w.ada.id, reason: REASON, bogus: 1 }, support);
    expect(await answerOf(bad)).toEqual({ status: 400, code: "invalid_body" });
    // Calls 2 to 100 of the secret with no delete scope: the limit runs before the scope check.
    for (let i = 2; i <= 100; i++) {
      const res = await call(w, DELETE, bodyOf(DELETE, w.ada.id), support);
      if (res.status !== 403) throw new Error(`call ${i} answered ${res.status}`);
    }
    const over = await call(w, DELETE, bodyOf(DELETE, w.ada.id), support);
    expect(await answerOf(over)).toEqual({ status: 429, code: "rate_limited" });
    expect(over.headers.get("cache-control")).toBe("no-store");
    // The update of the same secret has no count on the delete key.
    expect((await call(w, UPDATE, bodyOf(UPDATE, w.ada.id), support)).status).toBe(200);
    // Another secret, and a platform operator, each count on their own key.
    const bob = (await verifiedSession(w.auth, "bob@example.com")).user;
    const erased = await call(w, DELETE, bodyOf(DELETE, bob.id), operatorHeader(ERASURE));
    expect(erased.status).toBe(200);
    const carol = (await verifiedSession(w.auth, "carol@example.com")).user;
    expect((await call(w, DELETE, bodyOf(DELETE, carol.id), w.operatorCookie)).status).toBe(200);
    // One hour later the secret counts from zero again.
    w.auth.clock.advance(3600_000);
    const again = await call(w, DELETE, bodyOf(DELETE, w.ada.id), support);
    expect(await answerOf(again)).toEqual({ status: 403, code: "operator_required" });
    expect(await userOf(w, w.ada.id)).not.toBeNull();
  });

  it("counts each delete on operator-delete:actor with the actor kind and id, and no update", async () => {
    const keys: string[] = [];
    const w = await world({
      limiter: {
        allow: async (key: string) => {
          keys.push(key);
          return true;
        },
      },
    });
    const bob = (await verifiedSession(w.auth, "bob@example.com")).user;
    const carol = (await verifiedSession(w.auth, "carol@example.com")).user;
    const counted = () => keys.splice(0).filter((k) => k.startsWith("operator-delete:"));
    keys.length = 0;
    expect((await call(w, UPDATE, bodyOf(UPDATE, w.ada.id), operatorHeader(ERASURE))).status).toBe(
      200,
    );
    expect((await call(w, UPDATE, bodyOf(UPDATE, w.ada.id), w.operatorCookie)).status).toBe(200);
    expect(counted()).toEqual([]);
    expect((await call(w, DELETE, bodyOf(DELETE, bob.id), operatorHeader(ERASURE))).status).toBe(
      200,
    );
    expect(counted()).toEqual(["operator-delete:actor:secret:erasure"]);
    expect((await call(w, DELETE, bodyOf(DELETE, carol.id), w.operatorCookie)).status).toBe(200);
    expect(counted()).toEqual([`operator-delete:actor:user:${w.operator.user.id}`]);
    // A wrong secret has no actor, so it counts on no delete key.
    expect((await call(w, DELETE, bodyOf(DELETE, w.ada.id), operatorHeader(WRONG))).status).toBe(
      401,
    );
    expect(counted()).toEqual([]);
  });

  it("refuses an impersonation session at each route", async () => {
    const w = await world();
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const started = await w.handle(
      post("/auth/operator/impersonate", { userId: bob.user.id, reason: REASON }, w.operatorCookie),
    );
    expect(started.status).toBe(200);
    const sets = started.headers.getSetCookie();
    const name = w.auth.config.cookieName;
    const line = sets.find((s) => s.startsWith(`${name}=`)) ?? "";
    const token = line.slice(name.length + 1).split(";")[0] ?? "";
    expect(token).not.toBe("");
    const rows = (await auditRows(w)).length;
    for (const key of KEYS) {
      const res = await call(w, key, bodyOf(key, w.ada.id), { cookie: `${name}=${token}` });
      expect(await answerOf(res), key).toEqual({ status: 403, code: "impersonation_session" });
      expect(res.headers.get("cache-control"), key).toBe("no-store");
    }
    expect(await userOf(w, w.ada.id)).toEqual(w.ada);
    expect((await auditRows(w)).length).toBe(rows);
  });

  it("answers no-store, and keeps the Origin rule for a session caller", async () => {
    const w = await world();
    for (const key of KEYS) {
      // A cross-origin JSON post with the platform operator's cookie.
      const res = await call(w, key, bodyOf(key, w.ada.id), {
        ...w.operatorCookie,
        origin: "https://evil.example.com",
      });
      expect(await answerOf(res), key).toEqual({ status: 403, code: "origin_not_trusted" });
      // A cross-site form post with no Origin: the Fetch Metadata rule of plan 12b.
      const form = await w.handle(
        new Request(`https://api.example.com/auth${key.slice("POST ".length)}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "cross-site",
            ...w.operatorCookie,
          },
          body: new URLSearchParams({ userId: w.ada.id, reason: REASON }).toString(),
        }),
      );
      expect(await answerOf(form), key).toEqual({ status: 403, code: "origin_not_trusted" });
    }
    expect(await userOf(w, w.ada.id)).toEqual(w.ada);
    expect(await auditRows(w)).toEqual([]);
    // Every answer of the routes is no-store: 200, 400, 401, 403, and 409.
    const statuses = new Set<number>();
    const bob = (await verifiedSession(w.auth, "bob@example.com")).user;
    for (const [key, body, headers] of [
      [UPDATE, bodyOf(UPDATE, w.ada.id), operatorHeader(ERASURE)],
      [UPDATE, { userId: w.ada.id, reason: REASON }, operatorHeader(ERASURE)],
      [UPDATE, bodyOf(UPDATE, w.ada.id), operatorHeader(WRONG)],
      [DELETE, bodyOf(DELETE, w.ada.id), operatorHeader(OPERATOR_SECRETS.support)],
      [DELETE, bodyOf(DELETE, w.operator.user.id), w.operatorCookie],
      [DELETE, bodyOf(DELETE, bob.id), operatorHeader(ERASURE)],
    ] as const) {
      const res = await call(w, key, body, headers);
      statuses.add(res.status);
      expect(res.headers.get("cache-control"), `${key} ${res.status}`).toBe("no-store");
    }
    expect([...statuses].sort()).toEqual([200, 400, 401, 403, 409]);
  });

  it("answers the shapes of the contract", async () => {
    const w = await world();
    const erasure = operatorHeader(ERASURE);
    // The secret sets a name and an image; the platform operator clears the name.
    const named = await fitted(
      UPDATE,
      await call(
        w,
        UPDATE,
        {
          userId: w.ada.id,
          name: "Ada L.",
          image: "https://cdn.example.com/a.png",
          reason: REASON,
        },
        erasure,
      ),
    );
    expect(named).toMatchObject({
      user: { id: w.ada.id, email: ADA, name: "Ada L.", ban: null },
      auditId: expect.any(String),
    });
    const cleared = await fitted(
      UPDATE,
      await call(w, UPDATE, { userId: w.ada.id, name: null, reason: REASON }, w.operatorCookie),
    );
    expect(cleared).toMatchObject({ user: { id: w.ada.id, name: null } });
    expect((await userOf(w, w.ada.id))?.image).toBe("https://cdn.example.com/a.png");
    // A banned user with no end of the ban: the answer shows the ban.
    const ban = await w.handle(
      post("/auth/operator/users/ban", { userId: w.ada.id, reason: REASON }, erasure),
    );
    expect(ban.status).toBe(200);
    const banned = await fitted(
      UPDATE,
      await call(w, UPDATE, { userId: w.ada.id, name: "Ada", reason: REASON }, erasure),
    );
    expect(banned).toMatchObject({ user: { ban: { reason: REASON, until: null } } });
    // The secret deletes a user with a solo organization; the platform operator one with none.
    const bob = (await verifiedSession(w.auth, "bob@example.com")).user;
    const org = await soloOrganization(w, bob, "bob-co");
    const gone = await fitted(DELETE, await call(w, DELETE, bodyOf(DELETE, bob.id), erasure));
    expect(gone).toEqual({ organizations: [org.id], auditId: expect.any(String) });
    const goneToo = await fitted(
      DELETE,
      await call(w, DELETE, bodyOf(DELETE, w.ada.id), w.operatorCookie),
    );
    expect(goneToo).toEqual({ organizations: [], auditId: expect.any(String) });
    // One audit row per act, with field names and ids only.
    const rows = (await auditRows(w)).filter((r) => r.action !== "ban");
    expect(rows.map((r) => [r.actorKind, r.action, r.targetUserId, r.data])).toEqual([
      ["secret", "user_update", w.ada.id, { fields: ["name", "image"] }],
      ["user", "user_update", w.ada.id, { fields: ["name"] }],
      ["secret", "user_update", w.ada.id, { fields: ["name"] }],
      ["secret", "user_delete", bob.id, { organizations: [org.id] }],
      ["user", "user_delete", w.ada.id, { organizations: [] }],
    ]);
    expect(rows.map((r) => r.id)).toEqual([
      named.auditId,
      cleared.auditId,
      banned.auditId,
      gone.auditId,
      goneToo.auditId,
    ]);
    for (const r of rows) expect([r.reason, r.ip, r.userAgent]).toEqual([REASON, IP, AGENT]);
    expect(JSON.stringify(rows)).not.toContain(ADA);
  });

  it("updates and deletes a user with no address: a phone sign-up (plan 12i Task 1)", async () => {
    const sms = createRecordingSms();
    const w = await world({
      phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    });
    const phone = "+14155550123";
    const from = { "cf-connecting-ip": "203.0.113.71" };
    // The router of the world sends the code after the answer (ruling 23 of plan 12i).
    const handle = settled(w.handle);
    expect((await handle(post("/auth/phone/request", { phone }, from))).status).toBe(200);
    const code = /^(\d+) is your /.exec(sms.sent.findLast((m) => m.to === phone)?.text ?? "")?.[1];
    if (!code) throw new Error("no code in the text");
    const signedUp = await handle(
      post("/auth/phone/verify", { phone, code: recordCredential(code) }, from),
    );
    expect(signedUp.status).toBe(200);
    const id = ((await signedUp.json()) as { user: { id: string } }).user.id;
    expect(await userOf(w, id)).toMatchObject({ email: null, emailVerified: false });
    const erasure = operatorHeader(ERASURE);
    // The update answers the user with a null address, under the contract.
    const named = await fitted(
      UPDATE,
      await call(
        w,
        UPDATE,
        { userId: id, name: "Pat", image: "https://cdn.example.com/p.png", reason: REASON },
        erasure,
      ),
    );
    expect(named).toMatchObject({ user: { id, email: null, name: "Pat" } });
    expect(await userOf(w, id)).toMatchObject({
      name: "Pat",
      image: "https://cdn.example.com/p.png",
    });
    const cleared = await fitted(
      UPDATE,
      await call(w, UPDATE, { userId: id, name: null, image: null, reason: REASON }, erasure),
    );
    expect(cleared).toMatchObject({ user: { id, email: null, name: null } });
    // The delete answers ok; the notice has no address to go to, so no mail goes.
    const mails = w.auth.mail.length;
    const gone = await fitted(DELETE, await call(w, DELETE, bodyOf(DELETE, id), erasure));
    expect(gone).toEqual({ organizations: [], auditId: expect.any(String) });
    expect(await userOf(w, id)).toBeNull();
    expect(w.auth.mail.length).toBe(mails);
  });

  it("answers the refusals of each route through the router", async () => {
    const w = await world();
    const erasure = operatorHeader(ERASURE);
    const self = w.operator.user.id;
    for (const key of KEYS) {
      // A user actor never acts on their own user.
      const own = await call(w, key, bodyOf(key, self), w.operatorCookie);
      expect(await answerOf(own), key).toEqual({ status: 409, code: "operator_self" });
      // A user id that names no user.
      const none = await call(w, key, bodyOf(key, "x".repeat(26)), erasure);
      expect(await answerOf(none), key).toEqual({ status: 404, code: "not_found" });
      // A wrong secret.
      const wrong = await call(w, key, bodyOf(key, w.ada.id), operatorHeader(WRONG));
      expect(await answerOf(wrong), key).toEqual({ status: 401, code: "unauthorized" });
    }
    // A secret with no scope users, and a user actor on another platform operator.
    const dan = (await verifiedSession(w.auth, "dan@example.com")).user;
    const granted = await w.handle(
      post(
        "/auth/operator/users/platform-role",
        { userId: dan.id, grant: true, reason: REASON },
        operatorHeader(OPERATOR_SECRETS.support),
      ),
    );
    expect(granted.status).toBe(200);
    const rows = (await auditRows(w)).length;
    for (const key of KEYS) {
      const keys = await call(w, key, bodyOf(key, w.ada.id), operatorHeader(OPERATOR_SECRETS.keys));
      expect(await answerOf(keys), key).toEqual({ status: 403, code: "operator_required" });
      const other = await call(w, key, bodyOf(key, dan.id), w.operatorCookie);
      expect(await answerOf(other), key).toEqual({ status: 403, code: "operator_required" });
    }
    expect((await auditRows(w)).length).toBe(rows);
    expect(await userOf(w, dan.id)).not.toBeNull();
    // The last owner of an organization with another member keeps the account.
    const bob = (await verifiedSession(w.auth, "bob@example.com")).user;
    const org = await soloOrganization(w, w.ada, "ada-co");
    const added = await addMember(w.auth.config, {
      user: w.ada,
      organizationId: org.id,
      userId: bob.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    const sole = await call(w, DELETE, bodyOf(DELETE, w.ada.id), erasure);
    expect(await answerOf(sole)).toEqual({ status: 409, code: "sole_owner" });
    expect(await userOf(w, w.ada.id)).not.toBeNull();
    expect((await auditRows(w)).length).toBe(rows);
  });

  it("answers hook_refused and hook_failed of hooks.operator.beforeAction on each route", async () => {
    let mode: "refuse" | "throw" = "refuse";
    const w = await world({
      hooks: {
        operator: {
          beforeAction() {
            if (mode === "refuse") throw hookRefusal("Not in the change window.");
            throw new Error("the change system is down");
          },
        },
      },
    });
    for (const [m, answer] of [
      ["refuse", { status: 403, code: "hook_refused" }],
      ["throw", { status: 500, code: "hook_failed" }],
    ] as const) {
      mode = m;
      for (const key of KEYS) {
        const res = await call(w, key, bodyOf(key, w.ada.id), operatorHeader(ERASURE));
        expect(await answerOf(res), `${key} ${m}`).toEqual(answer);
      }
    }
    expect(await userOf(w, w.ada.id)).toEqual(w.ada);
    expect(await auditRows(w)).toEqual([]);
  });
});
