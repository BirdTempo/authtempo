import { describe, expect, it } from "vitest";
import { demoProviderFetch } from "../src/provider.js";
import {
  CALLBACK,
  call,
  challengeOf,
  codeFor,
  exchange,
  newSandbox,
  newVerifier,
  ORIGIN,
} from "./helpers.js";

// The refusals of the demo provider (Task 9 review of plan 11b, Low 2). The
// provider lives in one sandbox, but a later edit could drop each rule.
describe("the demo provider", () => {
  it("refuses a token step with a wrong secret or redirect, and spends no code", async () => {
    const jar = await newSandbox();
    const verifier = newVerifier();
    const code = await codeFor(jar, verifier);
    const step = (over: Record<string, string>) =>
      call(
        jar,
        "POST",
        "/provider/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: CALLBACK,
          client_id: "demo-provider-client",
          client_secret: "demo-provider-secret-not-a-secret",
          code_verifier: verifier,
          ...over,
        }),
      );
    for (const over of [
      { client_secret: "another-secret" },
      { redirect_uri: `${ORIGIN}/auth/social/other/callback` },
      { code_verifier: newVerifier() },
    ]) {
      const res = await step(over);
      expect({ over, status: res.status }).toEqual({ over, status: 400 });
      expect(await res.json()).toEqual({ error: "invalid_grant" });
    }
    // Each refusal left the code unspent, so the right step still passes.
    expect((await exchange(jar, code, verifier)).status).toBe(200);
  });

  it("answers the user call for a spent code only", async () => {
    const jar = await newSandbox();
    const verifier = newVerifier();
    const code = await codeFor(jar, verifier);
    const bearer = { authorization: `Bearer dat_${code}` };
    expect((await call(jar, "GET", "/provider/user", undefined, bearer)).status).toBe(401);
    expect((await exchange(jar, code, verifier)).status).toBe(200);
    const user = await call(jar, "GET", "/provider/user", undefined, bearer);
    expect(user.status).toBe(200);
    expect(await user.json()).toMatchObject({ email: "ada@example.com" });
  });

  it("refuses an authorize request with the plain PKCE method", async () => {
    const jar = await newSandbox();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "demo-provider-client",
      redirect_uri: CALLBACK,
      state: "s",
      code_challenge: await challengeOf(newVerifier()),
      code_challenge_method: "plain",
    });
    const res = await call(jar, "GET", `/provider/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("bad authorize request");
    q.set("code_challenge_method", "S256");
    expect((await call(jar, "GET", `/provider/authorize?${q}`)).status).toBe(200);
  });

  it("answers 502 to a social call outside the provider, and sends no request", async () => {
    // The provider route needs no store for a refused URL, so an empty one serves.
    const providerFetch = demoProviderFetch(ORIGIN, {} as D1Database);
    for (const url of ["https://example.com/token", `${ORIGIN}/auth/session`]) {
      const res = await providerFetch(url);
      expect({ url, status: res.status }).toEqual({ url, status: 502 });
    }
    // The teardown of test/outbound-teardown.ts fails the run on any request that left.
  });
});
