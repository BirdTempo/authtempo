import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { COOKIE_NAME } from "../../src/server/shapes.js";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import { adminApp, adminShim } from "../admin-helpers.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { counting } from "./counting.js";
import { execD1 } from "./schema.js";

// Plan 12f Task 13 on D1: Better Auth's impersonation paths through core's
// impersonation routes of Task 11. D1 Free allows 50 queries per
// invocation (D1 limits page updated 21 April 2026, read 2026-10-21). This
// file has its own storage, so its operator is the first one.

await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

describe("the admin impersonation on D1 (plan 12f Task 13)", () => {
  it("starts and stops an impersonation through the shim in 50 queries or fewer each", async () => {
    const setup = await adminApp(betterAuthSchemaStorage({ dialect: "d1", db: env.DB }));
    const ann = await setup.user("imp@example.com");
    // One invocation per call: a new storage and a new shim over the counting binding.
    const invoke = async (path: string, cookie: string, body?: unknown) => {
      const { db, count } = counting(env.DB);
      const shim = adminShim(betterAuthSchemaStorage({ dialect: "d1", db }));
      const res = await shim.handler(
        new Request(`https://api.example.com/api/auth${path}`, {
          method: "POST",
          headers: {
            origin: "https://api.example.com",
            cookie,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return { res, queries: count.queries };
    };
    const start = await invoke("/admin/impersonate-user", setup.op, { userId: ann.id });
    expect(start.res.status).toBe(200);
    const { session } = (await start.res.json()) as { session: { token: string } };
    const actor = start.res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${COOKIE_NAME}_actor=`))
      ?.split(";")[0];
    const stop = await invoke(
      "/admin/stop-impersonating",
      `${COOKIE_NAME}=${session.token}; ${actor}`,
    );
    expect(stop.res.status).toBe(200);
    // Core's route, then the shim's session read for Better Auth's { session, user }.
    // The stop also reads the operator's role: the platform organization and the member row.
    expect(start.queries).toBeLessThanOrEqual(50);
    expect(stop.queries).toBeLessThanOrEqual(50);
    expect([start.queries, stop.queries]).toEqual([32, 18]);
  });
});
