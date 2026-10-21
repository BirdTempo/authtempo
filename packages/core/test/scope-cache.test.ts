import { describe, expect, it } from "vitest";
import { createAuth } from "../src/create-auth.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";

// Plan 12h Task 4, ruling 1 point 9. The router copies the config for each
// request. So the per-request caller cache of tokens.ts keys on the instance,
// not on the config object.

describe("the caller cache under the request scope (plan 12h Task 4)", () => {
  it("spends one call of a token quota for one request through auth.caller and a route", async () => {
    const base = makeAuth();
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: base.storage,
      mail: { send: async () => {} },
      clock: base.clock,
    });
    const ada = await base.seedUser("ada@example.com");
    const made = await auth.api.tokens.create({ user: ada, name: "ci", quota: { remaining: 5 } });
    if (!made.ok) throw new Error(made.code);
    const one = new Request(`${BASE_URL}/auth/tokens/current`, {
      headers: { authorization: `Bearer ${made.value.token}` },
    });
    expect(await auth.caller(one)).toMatchObject({ kind: "token" });
    const res = await auth.handle(one);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ apiToken: { remaining: 4 } });
    const rows = await base.storage.findMany("apiToken", []);
    expect(rows.map((r) => r.remaining)).toEqual([4]);
  });

  it("keeps two instances apart on one storage", async () => {
    const base = makeAuth();
    const make = () =>
      createAuth({
        baseURL: BASE_URL,
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [APP_ORIGIN],
        storage: base.storage,
        mail: { send: async () => {} },
        clock: base.clock,
      });
    const [a, b] = [make(), make()];
    const ada = await base.seedUser("ada@example.com");
    const made = await a.api.tokens.create({ user: ada, name: "ci", quota: { remaining: 5 } });
    if (!made.ok) throw new Error(made.code);
    const one = new Request(`${BASE_URL}/auth/tokens/current`, {
      headers: { authorization: `Bearer ${made.value.token}` },
    });
    expect(await a.caller(one)).toMatchObject({ kind: "token" });
    expect(await b.caller(one)).toMatchObject({ kind: "token" });
    const rows = await base.storage.findMany("apiToken", []);
    expect(rows.map((r) => r.remaining)).toEqual([3]);
  });
});
