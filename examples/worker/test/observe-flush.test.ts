import { env, SELF } from "cloudflare:test";
import { createAuth } from "@authtempo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleConfig, exampleWorker, getAuth } from "../src/app.js";
import { BASE, lastLink } from "./helpers.js";

// The env of the test pool, typed as the Env of the Worker.
const workerEnv = env as unknown as Env;

/** A context whose waitUntil is a spy. `settle` awaits each promise that the Worker gave it. */
function spyContext() {
  const held: Promise<unknown>[] = [];
  const waitUntil = vi.fn((p: Promise<unknown>) => void held.push(p));
  const ctx = { waitUntil, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return { ctx, waitUntil, settle: () => Promise.all(held) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the flush of the example Worker (plan 12h ruling 13)", () => {
  for (const path of ["/auth/health", "/api/auth/health"]) {
    it(`passes waitUntil once to the handler of GET ${path}`, async () => {
      const { ctx, waitUntil, settle } = spyContext();
      const res = await exampleWorker(getAuth).fetch(new Request(`${BASE}${path}`), workerEnv, ctx);
      expect(res.status).toBe(200);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      await expect(settle()).resolves.toEqual([undefined]);
    });
  }

  it("flushes the fault of a session read on /me in the same request", async () => {
    const email = "observe-flush@example.com";
    const ask = await SELF.fetch(`${BASE}/auth/magic-link/request`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email }),
    });
    expect(ask.status).toBe(200);
    const token = (await lastLink()).searchParams.get("token") ?? "";
    const verify = await SELF.fetch(`${BASE}/auth/magic-link/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ token }),
    });
    expect(verify.status).toBe(200);
    const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // The session expires, as it does when its time passes.
    const ended = await env.DB.prepare(
      "UPDATE ta_session SET expires_at = 1 WHERE user_id = (SELECT id FROM ta_user WHERE email = ?)",
    )
      .bind(email)
      .run();
    expect(ended.meta.changes).toBe(1);

    let auth: ReturnType<typeof createAuth> | null = null;
    const app = exampleWorker((e) => {
      auth ??= createAuth({
        ...exampleConfig(e),
        hooks: {
          session: {
            afterEnd() {
              throw new RangeError("the tenant store is down");
            },
          },
        },
      });
      return auth;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, waitUntil, settle } = spyContext();
    const me = await app.fetch(new Request(`${BASE}/me`, { headers: { cookie } }), workerEnv, ctx);
    expect(me.status).toBe(401);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await settle();
    const lines = error.mock.calls.map((args) => args[0] as { name?: string; hook?: string });
    expect(lines).toContainEqual(
      expect.objectContaining({ name: "hook.after_failed", hook: "session.afterEnd" }),
    );
  });
});
