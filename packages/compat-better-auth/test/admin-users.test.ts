import { createMemoryAdapter, createMemoryLimiter, systemClock } from "@authtempo/core";
import { describe, expect, it, vi } from "vitest";
import { adminClient, createAuthClient } from "../src/client/index.js";
import { username } from "../src/plugins.js";
import type { CompatDatabase } from "../src/types.js";
import { APP, adminApp } from "./admin-helpers.js";

// Plan 12f2 Task 7: Better Auth's create-user (Wave B), update-user, and
// remove-user (Wave A) on core's operator create, update, and delete
// (ruling 1 B9 of plan 12f2). The shim posts core's routes with the
// caller's headers, so core's guard decides. set-user-password stays
// NOT_SUPPORTED.

const BASE = "https://api.example.com";

/**
 * A memory database whose storage counts each call while `counter.on` is
 * true. A refusal of the shim's own runs before any read, so it counts 0.
 */
function countedDatabase() {
  const counter = { on: false, calls: 0 };
  const inner = createMemoryAdapter();
  const storage = new Proxy(inner, {
    get(target, key, receiver) {
      const v: unknown = Reflect.get(target, key, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (counter.on) counter.calls++;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const database: CompatDatabase = {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage,
    limiter: createMemoryLimiter(systemClock),
  };
  return { database, counter };
}

const json = async (res: Response) => ({ status: res.status, body: await res.json() });

/** Better Auth's 403 codes of update-user (dist/plugins/admin/error-codes.mjs, read 2026-10-25). */
const SET_EMAIL = "YOU_ARE_NOT_ALLOWED_TO_SET_USERS_EMAIL";
const CHANGE_ROLE = "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE";
const BAN_USERS = "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS";

const thrown = async (call: Promise<unknown>) => {
  try {
    await call;
    return null;
  } catch (e) {
    const x = e as { statusCode: number; body: { code: string; message: string } };
    return { status: x.statusCode, code: x.body.code, message: x.body.message };
  }
};

describe("the admin update and remove of a user (plan 12f2 Task 7)", () => {
  it("maps update-user for the name and the image, and refuses email and password", async () => {
    const { database, counter } = countedDatabase();
    const a = await adminApp(database);
    const ann = await a.user("ann@example.com");

    const named = await json(
      await a.call(
        "/admin/update-user",
        { userId: ann.id, data: { name: "Ann Lee", image: "https://cdn.example.com/a.png" } },
        a.op,
      ),
    );
    // Better Auth answers the user itself, not { user } (routes.mjs adminUpdateUser).
    expect(named.status).toBe(200);
    expect(named.body).toMatchObject({
      id: ann.id,
      name: "Ann Lee",
      image: "https://cdn.example.com/a.png",
      role: "user",
      banned: false,
    });
    const row = await database.storage.findOne("user", [{ field: "id", op: "eq", value: ann.id }]);
    expect({ name: row?.name, image: row?.image }).toEqual({
      name: "Ann Lee",
      image: "https://cdn.example.com/a.png",
    });
    // Null clears the image.
    const cleared = await json(
      await a.call("/admin/update-user", { userId: ann.id, data: { image: null } }, a.op),
    );
    expect(cleared).toMatchObject({ status: 200, body: { name: "Ann Lee", image: null } });

    // Each refusal of a field comes before any storage call, and writes nothing.
    const refusals: [Record<string, unknown>, number, string, RegExp][] = [
      [
        { password: "new password 1" },
        400,
        "PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER",
        /spec section 26.*reset/,
      ],
      [
        { name: "Eve", password: "new password 1" },
        400,
        "PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER",
        /spec section 26/,
      ],
      // Better Auth's 403 codes, in its order: the role, the ban keys, the address
      // (review-12f2-task7 L1).
      [{ email: "eve@example.com" }, 403, SET_EMAIL, /spec section 8\.15 item 5/],
      [{ emailVerified: true }, 403, SET_EMAIL, /spec section 8\.15 item 5/],
      [{ role: "admin" }, 403, CHANGE_ROLE, /\/admin\/set-role/],
      [{ banned: true }, 403, BAN_USERS, /\/admin\/ban-user/],
      [{ banReason: "Spam" }, 403, BAN_USERS, /\/admin\/ban-user/],
      [{ banExpires: null }, 403, BAN_USERS, /\/admin\/ban-user/],
      [{ email: "eve@example.com", banned: true, role: "admin" }, 403, CHANGE_ROLE, /set-role/],
      [{ emailVerified: true, banReason: "Spam" }, 403, BAN_USERS, /\/admin\/ban-user/],
      [{ nickname: "eve", email: "eve@example.com" }, 403, SET_EMAIL, /8\.15 item 5/],
      [
        { role: "admin", password: "new password 1" },
        400,
        "PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER",
        /reset/,
      ],
      [{ name: "Eve", nickname: "eve" }, 400, "FIELD_NOT_ALLOWED", /nickname.*spec section 26/],
      [{}, 400, "NO_DATA_TO_UPDATE", /^No data to update$/],
    ];
    for (const [data, status, code, message] of refusals) {
      counter.on = true;
      counter.calls = 0;
      const res = await json(await a.call("/admin/update-user", { userId: ann.id, data }, a.op));
      counter.on = false;
      expect({ data, status: res.status, code: res.body.code, calls: counter.calls }).toEqual({
        data,
        status,
        code,
        calls: 0,
      });
      expect(res.body.message).toMatch(message);
    }
    const after = await database.storage.findOne("user", [
      { field: "id", op: "eq", value: ann.id },
    ]);
    expect({ name: after?.name, email: after?.email, emailVerified: after?.emailVerified }).toEqual(
      { name: "Ann Lee", email: "ann@example.com", emailVerified: true },
    );

    // Core's refusals in Better Auth's form: the caller's own user, an unknown
    // user, a bad name, and a caller with no platform role.
    expect(
      await json(
        await a.call("/admin/update-user", { userId: a.opId, data: { name: "Op" } }, a.op),
      ),
    ).toMatchObject({ status: 409, body: { code: "FORBIDDEN" } });
    expect(
      await json(
        await a.call("/admin/update-user", { userId: "nobody", data: { name: "X" } }, a.op),
      ),
    ).toEqual({ status: 404, body: { code: "USER_NOT_FOUND", message: "User not found" } });
    expect(
      await json(
        await a.call("/admin/update-user", { userId: ann.id, data: { image: "not a url" } }, a.op),
      ),
    ).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
    const bob = await a.user("bob@example.com");
    expect(
      await json(
        await a.call("/admin/update-user", { userId: ann.id, data: { name: "B" } }, bob.cookie),
      ),
    ).toMatchObject({ status: 403, body: { code: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_USERS" } });
    // A body with no data object.
    expect((await a.call("/admin/update-user", { userId: ann.id }, a.op)).status).toBe(400);

    // Two updates wrote two audit rows, each with the operator as the actor.
    expect(await a.audit(ann.id)).toEqual([
      {
        action: "user_update",
        actorKind: "user",
        actorId: a.opId,
        reason: "better-auth admin plugin /admin/update-user",
      },
      {
        action: "user_update",
        actorKind: "user",
        actorId: a.opId,
        reason: "better-auth admin plugin /admin/update-user",
      },
    ]);
  });

  it("maps an empty name of update-user to no name (review-12f2-task7 L2)", async () => {
    // Better Auth keeps an empty name; core keeps null for no name.
    const { database } = countedDatabase();
    const a = await adminApp(database);
    const ann = await a.user("ann@example.com");
    const named = await a.call(
      "/admin/update-user",
      { userId: ann.id, data: { name: "Ann" } },
      a.op,
    );
    expect(named.status).toBe(200);
    const unnamed = await json(
      await a.call("/admin/update-user", { userId: ann.id, data: { name: "" } }, a.op),
    );
    expect(unnamed).toMatchObject({ status: 200, body: { name: "" } });
    expect(
      (await database.storage.findOne("user", [{ field: "id", op: "eq", value: ann.id }]))?.name,
    ).toBeNull();
  });

  it("maps remove-user, and refuses the caller's own id", async () => {
    const { database } = countedDatabase();
    const a = await adminApp(database);
    const ann = await a.user("ann@example.com");

    expect(await json(await a.call("/admin/remove-user", { userId: ann.id }, a.op))).toEqual({
      status: 200,
      body: { success: true },
    });
    // The account is gone, and its session no longer opens.
    expect(
      await database.storage.findOne("user", [{ field: "id", op: "eq", value: ann.id }]),
    ).toBeNull();
    expect(await (await a.read("/get-session", ann.cookie)).json()).toBeNull();
    expect(await a.audit(ann.id)).toEqual([
      {
        action: "user_delete",
        actorKind: "user",
        actorId: a.opId,
        reason: "better-auth admin plugin /admin/remove-user",
      },
    ]);

    // Better Auth's own code and status for the caller's id (final-12f2-A I1).
    expect(await json(await a.call("/admin/remove-user", { userId: a.opId }, a.op))).toEqual({
      status: 400,
      body: { code: "YOU_CANNOT_REMOVE_YOURSELF", message: "You cannot remove yourself" },
    });
    expect(await json(await a.call("/admin/remove-user", { userId: ann.id }, a.op))).toEqual({
      status: 404,
      body: { code: "USER_NOT_FOUND", message: "User not found" },
    });
    // A caller with no platform role, and no session.
    const bob = await a.user("bob@example.com");
    expect(
      await json(await a.call("/admin/remove-user", { userId: a.opId }, bob.cookie)),
    ).toMatchObject({ status: 403, body: { code: "YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS" } });
    expect(await json(await a.call("/admin/remove-user", { userId: bob.id }))).toMatchObject({
      status: 401,
      body: { code: "UNAUTHORIZED" },
    });
    expect(
      await database.storage.findOne("user", [{ field: "id", op: "eq", value: bob.id }]),
    ).not.toBeNull();
  });

  it("refuses remove-user and update-user for an admin with no second factor", async () => {
    const { database } = countedDatabase();
    const a = await adminApp(database, { factor: false });
    const ann = await a.user("ann@example.com");
    expect(await json(await a.call("/admin/remove-user", { userId: ann.id }, a.op))).toMatchObject({
      status: 403,
      body: { code: "YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS" },
    });
    expect(
      await json(await a.call("/admin/update-user", { userId: ann.id, data: { name: "X" } }, a.op)),
    ).toMatchObject({ status: 403, body: { code: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_USERS" } });
    // Wave B: the create too.
    expect(
      await json(
        await a.call("/admin/create-user", { email: "dee@example.com", name: "Dee" }, a.op),
      ),
    ).toMatchObject({ status: 403, body: { code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS" } });
    expect(
      await database.storage.findOne("user", [
        { field: "email", op: "eq", value: "dee@example.com" },
      ]),
    ).toBeNull();
    const row = await database.storage.findOne("user", [{ field: "id", op: "eq", value: ann.id }]);
    expect(row?.name).toBeNull();
    expect(await a.audit(ann.id)).toEqual([]);
  });

  it("answers one body for set-user-password for an existing and an unknown user id with zero storage reads", async () => {
    const { database, counter } = countedDatabase();
    const a = await adminApp(database);
    const ann = await a.user("ann@example.com");
    const answers: unknown[] = [];
    counter.on = true;
    for (const userId of [ann.id, "nobody"])
      answers.push(
        await json(
          await a.call("/admin/set-user-password", { userId, newPassword: "new password 1" }, a.op),
        ),
      );
    counter.on = false;
    expect(counter.calls).toBe(0);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[0]).toMatchObject({ status: 501, body: { code: "NOT_SUPPORTED" } });
    expect((answers[0] as { body: { message: string } }).body.message).toMatch(
      /reset.*\(spec section 26 item 15\)$/,
    );
  });

  it("serves adminUpdateUser and removeUser of auth.api and of the client, and refuses a server call with no headers", async () => {
    const { database } = countedDatabase();
    const a = await adminApp(database);
    const ann = await a.user("ann@example.com");
    const bob = await a.user("bob@example.com");
    const cy = await a.user("cy@example.com");
    const headers = new Headers({ cookie: a.op });
    const api = a.auth.api;

    const updated = await api.adminUpdateUser({
      body: { userId: ann.id, data: { name: "Ann" } },
      headers,
    });
    expect(updated).toMatchObject({ id: ann.id, name: "Ann", role: "user" });
    // A server call answers dates, as Better Auth's does.
    expect(updated.updatedAt).toBeInstanceOf(Date);
    expect(
      await thrown(
        api.adminUpdateUser({
          // A JavaScript caller can send any key; the type takes name and image only.
          body: { userId: ann.id, data: { password: "x" } as never },
          headers,
        }),
      ),
    ).toMatchObject({ status: 400, code: "PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER" });
    expect(await api.removeUser({ body: { userId: ann.id }, headers })).toEqual({
      success: true,
    });
    // Better Auth's server form with no request: no session, so no actor (ruling 1 B9 item 2).
    expect(
      await thrown(api.removeUser({ body: { userId: bob.id }, headers: new Headers() })),
    ).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(
      await thrown(
        api.adminUpdateUser({
          body: { userId: bob.id, data: { name: "B" } },
          headers: new Headers(),
        }),
      ),
    ).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(await a.audit(bob.id)).toEqual([]);

    const seen: string[] = [];
    const admin = createAuthClient({
      baseURL: `${BASE}/api/auth`,
      plugins: [adminClient()],
      fetchOptions: {
        headers: { cookie: a.op },
        customFetchImpl: async (input, init) => {
          const req = new Request(input, init);
          seen.push(`${req.method} ${new URL(req.url).pathname}`);
          return a.auth.handler(req);
        },
      },
    }).admin;
    const viaClient = await admin.updateUser({ userId: bob.id, data: { name: "Bob" } });
    expect(viaClient.error).toBeNull();
    expect(viaClient.data).toMatchObject({ id: bob.id, name: "Bob" });
    expect(viaClient.data?.createdAt).toBeInstanceOf(Date);
    expect(await admin.removeUser({ userId: cy.id })).toEqual({
      data: { success: true },
      error: null,
    });
    const self = await admin.removeUser({ userId: a.opId });
    expect({ code: self.error?.code, status: self.error?.status }).toEqual({
      code: "YOU_CANNOT_REMOVE_YOURSELF",
      status: 400,
    });
    expect(seen).toEqual([
      "POST /api/auth/admin/update-user",
      "POST /api/auth/admin/remove-user",
      "POST /api/auth/admin/remove-user",
    ]);
  });
});

/** The user row of an address, or null. */
const byAddress = (database: CompatDatabase, email: string) =>
  database.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);

describe("the admin create of a user (plan 12f2 Task 7, Wave B)", () => {
  it("maps create-user and sends no mail", async () => {
    const { database } = countedDatabase();
    const a = await adminApp(database);
    const mails = a.links.length;

    const made = await json(
      await a.call(
        "/admin/create-user",
        {
          email: "Dee@Example.com",
          name: "Dee",
          data: { emailVerified: true, image: "https://cdn.example.com/d.png" },
        },
        a.op,
      ),
    );
    expect(made.status).toBe(200);
    const dee = await byAddress(database, "dee@example.com");
    if (!dee) throw new Error("no user dee");
    // Better Auth answers { user } (routes.mjs createUser), with the admin fields.
    expect(Object.keys(made.body)).toEqual(["user"]);
    expect(Object.keys(made.body.user).sort()).toEqual(
      [
        "banExpires",
        "banReason",
        "banned",
        "createdAt",
        "email",
        "emailVerified",
        "id",
        "image",
        "name",
        "role",
        "twoFactorEnabled",
        "updatedAt",
      ].sort(),
    );
    expect(made.body.user).toMatchObject({
      id: dee.id,
      email: "dee@example.com",
      name: "Dee",
      emailVerified: true,
      image: "https://cdn.example.com/d.png",
      role: "user",
      banned: false,
      banReason: null,
      banExpires: null,
      twoFactorEnabled: false,
      createdAt: dee.createdAt.toISOString(),
    });
    expect({ emailVerified: dee.emailVerified, image: dee.image }).toEqual({
      emailVerified: true,
      image: "https://cdn.example.com/d.png",
    });

    // The default role maps to nothing, top level, in data, and as a list.
    // An empty name is no name, as on update-user.
    for (const [email, extra] of [
      ["eve@example.com", { role: "user" }],
      ["fay@example.com", { role: ["user"], data: { role: "user" } }],
    ] as const) {
      const res = await json(
        await a.call("/admin/create-user", { email, name: "", ...extra }, a.op),
      );
      expect(res).toMatchObject({
        status: 200,
        body: { user: { email, name: "", emailVerified: false, image: null, role: "user" } },
      });
      expect((await byAddress(database, email))?.name).toBeNull();
    }

    // firstSignIn none: core wrote no invitation and mailed no link (Better
    // Auth mails nothing at create). The audit row names the operator.
    const rows = await a.auth.tempo.api.operator.audit.list({ actor: APP, targetUserId: dee.id });
    if (!rows.ok) throw new Error(rows.code);
    expect(
      rows.value.rows.map((r) => ({
        action: r.action,
        actorKind: r.actorKind,
        actorId: r.actorId,
        reason: r.reason,
        data: r.data,
      })),
    ).toEqual([
      {
        action: "user_create",
        actorKind: "user",
        actorId: a.opId,
        reason: "better-auth admin plugin /admin/create-user",
        data: { emailVerified: true, firstSignIn: "none", hasAddress: true, hasPhone: false },
      },
    ]);
    expect(a.links.length).toBe(mails);
  });

  it("gives the created user the fields of the sign-in plugins (plan 12i)", async () => {
    const { database } = countedDatabase();
    // The anonymous plugin needs a shared limiter, which this memory database lacks.
    const a = await adminApp(database, { plugins: [username()] });
    const made = await json(
      await a.call("/admin/create-user", { email: "dee@example.com", name: "Dee" }, a.op),
    );
    expect(made.status).toBe(200);
    expect(made.body.user).toMatchObject({
      email: "dee@example.com",
      username: null,
      displayUsername: null,
    });
    // A username is a field of the username plugin's own paths, not of an operator create.
    expect(
      await json(
        await a.call(
          "/admin/create-user",
          { email: "eve@example.com", name: "Eve", data: { username: "eve" } },
          a.op,
        ),
      ),
    ).toMatchObject({ status: 400, body: { code: "FIELD_NOT_ALLOWED" } });
  });

  it("passes the host's waitUntil to core's create route (review-12f2-task7b I1)", async () => {
    const { database } = countedDatabase();
    const a = await adminApp(database);
    const handle = vi.spyOn(a.auth.tempo, "handle");
    const held: Promise<unknown>[] = [];
    const res = await a.auth.handler(
      new Request(`${BASE}/api/auth/admin/create-user`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json", cookie: a.op },
        body: JSON.stringify({ email: "wu@example.com", name: "Wu" }),
      }),
      { waitUntil: (p: Promise<unknown>) => void held.push(p) },
    );
    expect(res.status).toBe(200);
    // The inner call of core's route gets a waitUntil, so work that core
    // posts after its answer reaches the host's one promise.
    const inner = handle.mock.calls.filter(([r]) =>
      new URL(r.url).pathname.endsWith("/operator/users/create"),
    );
    expect(inner).toHaveLength(1);
    expect(typeof inner[0]?.[1]?.waitUntil).toBe("function");
    expect(held).toHaveLength(1);
    await Promise.all(held);
    handle.mockRestore();
  });

  it("refuses create-user with a password and writes nothing", async () => {
    const { database, counter } = countedDatabase();
    const a = await adminApp(database);
    // Each refusal comes before any storage call, with Better Auth's code of
    // the path where it has one (spec 26). No key drops in silence.
    const refusals: [Record<string, unknown>, number, string, RegExp][] = [
      [
        { password: "correct horse battery" },
        403,
        "YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD",
        /reset link \(spec section 26 item 15\)$/,
      ],
      [
        { password: "", data: { emailVerified: true } },
        403,
        "YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD",
        /spec section 26/,
      ],
      [{ role: "admin" }, 403, "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE", /\/admin\/set-role/],
      [
        { role: ["user", "admin"] },
        403,
        "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE",
        /\/admin\/set-role/,
      ],
      [
        { data: { role: "admin" } },
        403,
        "YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE",
        /\/admin\/set-role/,
      ],
      [{ data: { banned: true } }, 403, "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS", /\/admin\/ban-user/],
      [
        { data: { banReason: "Spam" } },
        403,
        "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS",
        /\/admin\/ban-user/,
      ],
      [
        { data: { banExpires: null } },
        403,
        "YOU_ARE_NOT_ALLOWED_TO_BAN_USERS",
        /\/admin\/ban-user/,
      ],
      // Better Auth's schema and handler for a role of the wrong type (review-12f2-task7b I2).
      [{ role: null }, 400, "VALIDATION_ERROR", /^Validation error$/],
      [{ role: ["user", 1] }, 400, "VALIDATION_ERROR", /^Validation error$/],
      [{ role: null, password: "x" }, 400, "VALIDATION_ERROR", /^Validation error$/],
      [{ data: { role: null } }, 400, "INVALID_ROLE_TYPE", /^Invalid role type$/],
      [{ data: { role: ["user", 2] } }, 400, "INVALID_ROLE_TYPE", /^Invalid role type$/],
      [{ data: { name: "Eve" } }, 400, "FIELD_NOT_ALLOWED", /name.*spec section 26/],
      [{ data: { email: "eve@example.com" } }, 400, "FIELD_NOT_ALLOWED", /email.*spec section 26/],
      [
        { data: { phoneNumber: "+14155550100" } },
        400,
        "FIELD_NOT_ALLOWED",
        /phoneNumber.*spec section 26/,
      ],
      [{ data: { nickname: "x" } }, 400, "FIELD_NOT_ALLOWED", /nickname.*spec section 26/],
    ];
    for (const [i, [extra, status, code, message]] of refusals.entries()) {
      const email = `refused-${i}@example.com`;
      counter.on = true;
      counter.calls = 0;
      const res = await json(
        await a.call("/admin/create-user", { email, name: "Refused", ...extra }, a.op),
      );
      counter.on = false;
      expect({ extra, status: res.status, code: res.body.code, calls: counter.calls }).toEqual({
        extra,
        status,
        code,
        calls: 0,
      });
      expect(res.body.message).toMatch(message);
      expect(await byAddress(database, email)).toBeNull();
    }
    const rows = await a.auth.tempo.api.operator.audit.list({ actor: APP });
    if (!rows.ok) throw new Error(rows.code);
    expect(rows.value.rows.filter((r) => r.action === "user_create")).toEqual([]);
  });

  it("maps a taken address to USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL with 400", async () => {
    const { database } = countedDatabase();
    const a = await adminApp(database);
    await a.user("ann@example.com");
    const bob = await a.user("bob@example.com");
    const create = (body: Record<string, unknown>, cookie = a.op) =>
      a.call("/admin/create-user", body, cookie).then(json);

    // Better Auth's code and status (routes.mjs createUser, read 2026-10-25), for any case.
    for (const email of ["ann@example.com", "ANN@Example.com"])
      expect(await create({ email, name: "Ann" })).toEqual({
        status: 400,
        body: {
          code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
          message: "User already exists. Use another email.",
        },
      });
    expect(await create({ email: "not an address", name: "X" })).toEqual({
      status: 400,
      body: { code: "INVALID_EMAIL", message: "Invalid email" },
    });
    // A placeholder address reads back as no address, so it is never proved (plan 12i).
    expect(
      await create({
        email: "u1@anonymous.placeholder.invalid",
        name: "X",
        data: { emailVerified: true },
      }),
    ).toMatchObject({ status: 403, body: { code: "HOOK_REFUSED" } });
    // Better Auth requires the name, and core checks the image.
    expect(await create({ email: "x@example.com" })).toMatchObject({
      status: 400,
      body: { code: "VALIDATION_ERROR" },
    });
    expect(
      await create({ email: "x@example.com", name: "X", data: { image: "not a url" } }),
    ).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
    // A caller with no platform role, and no session.
    expect(await create({ email: "x@example.com", name: "X" }, bob.cookie)).toMatchObject({
      status: 403,
      body: { code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS" },
    });
    expect(await create({ email: "x@example.com", name: "X" }, "")).toMatchObject({
      status: 401,
      body: { code: "UNAUTHORIZED" },
    });
    for (const email of ["x@example.com", "u1@anonymous.placeholder.invalid"])
      expect(await byAddress(database, email)).toBeNull();
    const rows = await a.auth.tempo.api.operator.audit.list({ actor: APP });
    if (!rows.ok) throw new Error(rows.code);
    expect(rows.value.rows.filter((r) => r.action === "user_create")).toEqual([]);
  });

  it("serves createUser of auth.api and of the client, and refuses a server call with no headers", async () => {
    const { database } = countedDatabase();
    const a = await adminApp(database);
    const api = a.auth.api;
    const made = await api.createUser({
      body: { email: "dee@example.com", name: "Dee" },
      headers: new Headers({ cookie: a.op }),
    });
    expect(made.user).toMatchObject({ email: "dee@example.com", name: "Dee", role: "user" });
    // A server call answers dates, as Better Auth's does.
    expect(made.user.createdAt).toBeInstanceOf(Date);
    expect(
      await thrown(
        api.createUser({
          // A JavaScript caller can send any key; the type has no password.
          body: { email: "eve@example.com", name: "Eve", password: "x" } as never,
          headers: new Headers({ cookie: a.op }),
        }),
      ),
    ).toMatchObject({ status: 403, code: "YOU_ARE_NOT_ALLOWED_TO_SET_USERS_PASSWORD" });
    // Better Auth's server form with no request: no session, so no actor (ruling 1 B9 item 2).
    expect(
      await thrown(
        api.createUser({ body: { email: "eve@example.com", name: "Eve" }, headers: new Headers() }),
      ),
    ).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(await byAddress(database, "eve@example.com")).toBeNull();

    const seen: string[] = [];
    const admin = createAuthClient({
      baseURL: `${BASE}/api/auth`,
      plugins: [adminClient()],
      fetchOptions: {
        headers: { cookie: a.op },
        customFetchImpl: async (input, init) => {
          const req = new Request(input, init);
          seen.push(`${req.method} ${new URL(req.url).pathname}`);
          return a.auth.handler(req);
        },
      },
    }).admin;
    const viaClient = await admin.createUser({
      email: "fay@example.com",
      name: "Fay",
      data: { emailVerified: true },
    });
    expect(viaClient.error).toBeNull();
    expect(viaClient.data?.user).toMatchObject({ email: "fay@example.com", emailVerified: true });
    expect(viaClient.data?.user.createdAt).toBeInstanceOf(Date);
    const taken = await admin.createUser({ email: "fay@example.com", name: "Fay" });
    expect({ code: taken.error?.code, status: taken.error?.status }).toEqual({
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      status: 400,
    });
    expect(seen).toEqual(["POST /api/auth/admin/create-user", "POST /api/auth/admin/create-user"]);
  });
});
