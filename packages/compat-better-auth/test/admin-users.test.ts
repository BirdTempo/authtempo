import { createMemoryAdapter, createMemoryLimiter, systemClock } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { adminClient, createAuthClient } from "../src/client/index.js";
import type { CompatDatabase } from "../src/types.js";
import { adminApp } from "./admin-helpers.js";

// Plan 12f2 Task 7 (Wave A): Better Auth's update-user and remove-user on
// core's operator update and delete (ruling 1 B9 of plan 12f2). The shim
// posts core's routes with the caller's headers, so core's guard decides.
// set-user-password stays NOT_SUPPORTED. create-user waits for Wave B.

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
      [{ email: "eve@example.com" }, 400, "FIELD_NOT_ALLOWED", /spec section 8\.15 item 5/],
      [{ emailVerified: true }, 400, "FIELD_NOT_ALLOWED", /spec section 8\.15 item 5/],
      [{ role: "admin" }, 400, "FIELD_NOT_ALLOWED", /\/admin\/set-role/],
      [{ banned: true }, 400, "FIELD_NOT_ALLOWED", /\/admin\/ban-user/],
      [{ banReason: "Spam" }, 400, "FIELD_NOT_ALLOWED", /\/admin\/ban-user/],
      [{ banExpires: null }, 400, "FIELD_NOT_ALLOWED", /\/admin\/ban-user/],
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

    // Better Auth's own code for the caller's id; core's status stays, 409.
    expect(await json(await a.call("/admin/remove-user", { userId: a.opId }, a.op))).toEqual({
      status: 409,
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
      status: 409,
    });
    expect(seen).toEqual([
      "POST /api/auth/admin/update-user",
      "POST /api/auth/admin/remove-user",
      "POST /api/auth/admin/remove-user",
    ]);
  });
});
