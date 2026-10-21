import { env } from "cloudflare:test";
import type { MailMessage } from "@authtempo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";

const BASE = "https://example.test";
const json = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

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

describe("the flush of the D1 Worker (plan 12h ruling 13)", () => {
  it("passes waitUntil once to handle for GET /auth/health", async () => {
    const { ctx, waitUntil, settle } = spyContext();
    const res = await createWorker({ async send() {} }).fetch(
      new Request(`${BASE}/auth/health`),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(settle()).resolves.toEqual([undefined]);
  });

  it("flushes the fault of a session read on /me in the same request", async () => {
    const sent: MailMessage[] = [];
    const app = createWorker(
      {
        async send(m) {
          sent.push(m);
        },
      },
      {
        session: {
          afterEnd() {
            throw new RangeError("the tenant store is down");
          },
        },
      },
    );
    const email = "observe-flush@example.com";
    await app.fetch(json("/auth/magic-link/request", { email }), env, spyContext().ctx);
    const link = /https:\/\/\S+/.exec(sent.at(-1)?.text ?? "")?.[0] ?? "";
    const token = new URL(link).searchParams.get("token") ?? "";
    const verify = await app.fetch(
      json("/auth/magic-link/verify", { token }),
      env,
      spyContext().ctx,
    );
    expect(verify.status).toBe(200);
    const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // The session expires, as it does when its time passes.
    const ended = await env.DB.prepare(
      "UPDATE ta_session SET expires_at = 1 WHERE user_id = (SELECT id FROM ta_user WHERE email = ?)",
    )
      .bind(email)
      .run();
    expect(ended.meta.changes).toBe(1);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, waitUntil, settle } = spyContext();
    const me = await app.fetch(new Request(`${BASE}/me`, { headers: { cookie } }), env, ctx);
    expect(me.status).toBe(401);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await settle();
    const lines = error.mock.calls.map((args) => args[0] as { name?: string; hook?: string });
    expect(lines).toContainEqual(
      expect.objectContaining({ name: "hook.after_failed", hook: "session.afterEnd" }),
    );
  });
});
