import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";

const BASE = "https://api.example.com";

/** A fetch that answers 200 with the body to every request. */
const answering = (body: string) =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;

// A baseURL that points at another JSON service, or a captive portal, answers 200 with a body
// that is not a session (plan 11d Task 13 review, M1).
const WRONG = ['{"nope":1}', "[]", '"x"', '{"user":{"email":"a@b.c"},"session":{"id":"s"}}'];

describe("the shape of a session answer (plan 11d)", () => {
  it("answers unexpected with status 200 for a session read of the wrong shape", async () => {
    for (const body of WRONG)
      expect(await createClient({ baseURL: BASE, fetch: answering(body) }).session(), body).toEqual(
        { ok: false, code: "unexpected", status: 200 },
      );
  });

  it("answers the session for a body of the right shape, and null for a 200 null", async () => {
    const good = { user: { id: "u1", email: "a@b.c" }, session: { id: "s1" } };
    expect(
      await createClient({ baseURL: BASE, fetch: answering(JSON.stringify(good)) }).session(),
    ).toEqual({ ok: true, value: good });
    expect(await createClient({ baseURL: BASE, fetch: answering("null") }).session()).toEqual({
      ok: true,
      value: null,
    });
  });

  it("shows the error in the store for a session read of the wrong shape", async () => {
    const client = createClient({
      baseURL: BASE,
      fetch: answering('{"nope":1}'),
      broadcast: false,
    });
    const stop = client.store.subscribe(() => {});
    await vi.waitFor(() => expect(client.store.get().isPending).toBe(false));
    expect(client.store.get()).toMatchObject({
      data: null,
      error: { ok: false, code: "unexpected", status: 200 },
    });
    stop();
  });

  it("answers unexpected for a handoff redeem of the wrong shape, or with no token", async () => {
    const noToken = '{"user":{"id":"u1"},"session":{"id":"s1"}}';
    for (const body of [...WRONG, noToken])
      expect(
        await createClient({ baseURL: BASE, fetch: answering(body) }).handoff.redeem({
          code: "hc_x",
          verifier: "v",
        }),
        body,
      ).toEqual({ ok: false, code: "unexpected", status: 200 });
  });
});
