import { createClient } from "@authtempo/client";
import { describe, expect, it } from "vitest";
import { API, call, codeIn, harness } from "../support/harness.ts";
import { createEmailCodeAuth } from "./email-code.ts";
import { signInByCode } from "./email-code-client.ts";

describe("sign in with an email code", () => {
  it("signs a device in with the code of the mail", async () => {
    const h = harness();
    const auth = createEmailCodeAuth(h);
    const client = createClient({
      baseURL: API,
      credentials: "omit",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        auth.handle(new Request(input, init))) as typeof fetch,
    });
    const r = await signInByCode(client, "ada@example.com", async () =>
      codeIn(h, "ada@example.com"),
    );
    expect(r.ok && "token" in r.value && r.value.token.startsWith("ts_")).toBe(true);
  });

  it("answers invalid_code to a wrong code, and too_many_attempts at the fifth", async () => {
    const h = harness();
    const auth = createEmailCodeAuth(h);
    await call(auth, "POST", "/auth/otp/request", { email: "bo@example.com" });
    const right = codeIn(h, "bo@example.com");
    const wrong = right === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < 4; i++)
      expect(
        await (
          await call(auth, "POST", "/auth/otp/verify", { email: "bo@example.com", code: wrong })
        ).json(),
      ).toEqual({
        error: "invalid_code",
      });
    expect(
      await (
        await call(auth, "POST", "/auth/otp/verify", { email: "bo@example.com", code: wrong })
      ).json(),
    ).toEqual({
      error: "too_many_attempts",
    });
    expect(
      await (
        await call(auth, "POST", "/auth/otp/verify", { email: "bo@example.com", code: right })
      ).json(),
    ).toEqual({
      error: "too_many_attempts",
    });
  });
});
