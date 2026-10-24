import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer } from "./harness.js";

describe("the anonymous sign-in (plan 12i Task 6)", () => {
  it("signs in a guest, refuses a route that needs a way in, and deletes the guest", async () => {
    const server = makeServer({ anonymous: { isolateLimiter: "allow" } });
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    const signedIn = await client.anonymous.signIn();
    expect(signedIn).toMatchObject({ ok: true, value: { user: { email: null } } });
    // The live anonymous session answers itself.
    const again = await client.anonymous.signIn();
    expect(again.ok && signedIn.ok && again.value.token === signedIn.value.token).toBe(true);
    expect(await client.tokens.create({ name: "ci" })).toMatchObject({
      ok: false,
      code: "anonymous_refused",
      status: 403,
    });
    expect(await client.anonymous.delete()).toEqual({ ok: true, value: { ok: true } });
    expect(await client.anonymous.delete()).toMatchObject({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
  });

  it("answers not_found while the server has no anonymous config", async () => {
    const server = makeServer();
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    expect(await client.anonymous.signIn()).toMatchObject({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });
});
