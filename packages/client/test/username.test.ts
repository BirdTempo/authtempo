import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

describe("the username (plan 12i Task 2)", () => {
  it("checks a name, sets it with a fresh session, and passes the refusals through", async () => {
    const server = makeServer({ username: {} });
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    expect(await client.username.available({ username: "Ada" })).toEqual({
      ok: true,
      value: { available: true },
    });
    expect(await client.username.set({ username: "Ada" })).toMatchObject({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    await client.magicLink.request({ email: "ada@example.com" });
    const v = await client.magicLink.verify({ token: tokenFromMail(server.mail[0]?.text ?? "") });
    expect(v.ok).toBe(true);
    expect(await client.username.set({ username: "Ada" })).toEqual({
      ok: true,
      value: { username: "ada", displayUsername: "Ada" },
    });
    expect(await client.username.available({ username: "ADA" })).toEqual({
      ok: true,
      value: { available: false },
    });
    expect(await client.username.set({ username: "ada@home" })).toMatchObject({
      ok: false,
      code: "username_invalid",
      status: 400,
    });
  });

  it("answers not_found while the server has no username config", async () => {
    const server = makeServer();
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    expect(await client.username.available({ username: "ada" })).toMatchObject({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });
});
