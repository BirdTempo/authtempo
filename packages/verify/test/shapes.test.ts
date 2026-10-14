import { describe, expect, it } from "vitest";
import { createVerifier } from "../src/index.js";
import { FILES, ISSUER, makeClock, ownKey, withBearer } from "./harness.js";

/** A fetch that answers every path with one fixed 200 JSON body: a proxy page or a wrong route. */
function answers(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

const unexpected200 = { ok: false, code: "unexpected", status: 200 };

describe("a 200 answer of the auth app is checked at run time (Task 9 review MJ1)", () => {
  for (const body of [{}, [], null, { user: { id: "u" } }, { user: {}, apiToken: { id: "t" } }]) {
    it(`answers unexpected for the API token answer ${JSON.stringify(body)}`, async () => {
      const v = createVerifier({ issuer: ISSUER, accept: ["api-token"], fetch: answers(body) });
      expect(await v.verifyRequest(withBearer(FILES, "tk_any"))).toEqual(unexpected200);
    });
  }

  for (const body of [{}, [], null, { user: { id: "u" }, session: { id: 1 } }]) {
    it(`answers unexpected for the session answer ${JSON.stringify(body)}`, async () => {
      const v = createVerifier({ issuer: ISSUER, accept: ["session-token"], fetch: answers(body) });
      expect(await v.verifyRequest(withBearer(FILES, "ts_any"))).toEqual(unexpected200);
    });
  }

  for (const body of [{}, [], null, { live: "yes" }]) {
    it(`answers unexpected for the live answer ${JSON.stringify(body)}`, async () => {
      const clock = makeClock();
      const key = await ownKey();
      const exp = Math.floor(clock.now().getTime() / 1000) + 600;
      const token = await key.sign(
        { typ: "JWT" },
        {
          iss: ISSUER,
          sub: "u",
          sid: "s",
          aud: FILES,
          exp,
          email: "a@example.com",
          email_verified: true,
        },
      );
      const v = createVerifier({
        issuer: ISSUER,
        audience: FILES,
        checkSessionEnd: true,
        clock,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
          new Request(input, init).url.endsWith("/jwks")
            ? key.fetch(input, init)
            : new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
      });
      expect(await v.verifyRequest(withBearer(FILES, token))).toEqual(unexpected200);
    });
  }
});

describe("the typ rule of a session JWT (Task 9 review M3)", () => {
  it("answers the caller for typ JWT and null for no typ, jwt, and logout+jwt, under one key", async () => {
    const clock = makeClock();
    const key = await ownKey();
    const exp = Math.floor(clock.now().getTime() / 1000) + 600;
    const claims = {
      iss: ISSUER,
      sub: "u",
      sid: "s",
      aud: FILES,
      exp,
      email: "a@example.com",
      email_verified: true,
    };
    const v = createVerifier({ issuer: ISSUER, audience: FILES, clock, fetch: key.fetch });
    // The control: the same key and claims with typ JWT give a caller, so a null below is the typ.
    const good = await v.verifyRequest(withBearer(FILES, await key.sign({ typ: "JWT" }, claims)));
    expect(good.ok && good.value?.kind).toBe("session-jwt");
    for (const header of [{}, { typ: "jwt" }, { typ: "logout+jwt" }])
      expect(await v.verifyRequest(withBearer(FILES, await key.sign(header, claims)))).toEqual({
        ok: true,
        value: null,
      });
  });
});
