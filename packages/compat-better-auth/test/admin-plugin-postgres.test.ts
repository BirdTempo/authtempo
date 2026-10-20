import { afterEach, describe, expect, it } from "vitest";
import { COOKIE_NAME } from "../src/server/shapes.js";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { adminApp, adminShim, PASSWORD } from "./admin-helpers.js";
import { BETTER_AUTH_PG } from "./fixtures.js";
import { freshBetterAuthSchema } from "./pg.js";

// Plan 12f Task 13 on Postgres: a ban through Better Auth's admin path
// lives in core's compat columns (taBannedAt, taBanReason, taBanUntil), so
// a new instance of the shim on the same database reads it. An
// impersonation session keeps its operator in the compat column taActorId.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("the admin plugin on Postgres (plan 12f Task 13)", () => {
  it("keeps a ban in the compat columns across a restart of the shim", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    closers.push(() => pg.close());
    const first = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    await first.migrate();
    const a = await adminApp(first);
    const ann = await a.user("ann@example.com");
    const ban = await a.call(
      "/admin/ban-user",
      { userId: ann.id, banReason: "Spam", banExpiresIn: 86_400 },
      a.op,
    );
    expect(ban.status).toBe(200);
    // Core's own columns hold the ban, under the compat names.
    const [row] = await pg.sql<
      { taBannedAt: Date | null; taBanReason: string | null; taBanUntil: Date | null }[]
    >`SELECT "taBannedAt", "taBanReason", "taBanUntil" FROM "user" WHERE "id" = ${ann.id}`;
    expect(row?.taBanReason).toBe("Spam");
    expect(row?.taBannedAt).toBeInstanceOf(Date);
    expect(row?.taBanUntil).toBeInstanceOf(Date);

    // A new shim on a new storage: no state of the first instance stays.
    const restarted = adminShim(betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql }));
    const signIn = await restarted.handler(
      new Request("https://api.example.com/api/auth/password/sign-in", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://api.example.com" },
        body: JSON.stringify({ email: "ann@example.com", password: PASSWORD }),
      }),
    );
    expect({ status: signIn.status, body: await signIn.json() }).toMatchObject({
      status: 403,
      body: { error: "account_banned" },
    });
    const user = await restarted.tempo.api.operator.users.get({
      actor: { kind: "app", name: "check" },
      userId: ann.id,
    });
    if (!user.ok) throw new Error(user.code);
    expect(user.value.ban?.reason).toBe("Spam");
  });

  it("keeps the operator of an impersonation in taActorId, and the stop ends the row", async () => {
    const pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
    closers.push(() => pg.close());
    const storage = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
    await storage.migrate();
    const a = await adminApp(storage);
    const ann = await a.user("ann@example.com");
    const start = await a.call("/admin/impersonate-user", { userId: ann.id }, a.op);
    expect(start.status).toBe(200);
    const { session } = (await start.json()) as { session: { id: string; token: string } };
    const rows = () =>
      pg.sql<
        { taActorId: string | null }[]
      >`SELECT "taActorId" FROM "session" WHERE "id" = ${session.id}`;
    expect(await rows()).toEqual([{ taActorId: a.opId }]);
    const actor = start.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${COOKIE_NAME}_actor=`))
      ?.split(";")[0];
    const stop = await a.call(
      "/admin/stop-impersonating",
      undefined,
      `${COOKIE_NAME}=${session.token}; ${actor}`,
    );
    expect(stop.status).toBe(200);
    expect(await rows()).toEqual([]);
    // Two ids of one millisecond have no order (a ULID), so the rows go by action.
    expect((await a.audit(ann.id)).map((r) => [r.action, r.actorId]).sort()).toEqual([
      ["impersonation_start", a.opId],
      ["impersonation_stop", a.opId],
    ]);
  });
});
