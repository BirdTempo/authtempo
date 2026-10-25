import { describe, expect, it } from "vitest";
import { harness } from "../support/harness.ts";
import { createTwoHostAuth } from "./base-url-list.ts";

describe("serve one deployment on a list of hosts", () => {
  it("names the issuer of the request's host", async () => {
    const auth = createTwoHostAuth(harness());
    for (const host of ["https://auth.example.com", "https://auth.example.org"]) {
      const res = await auth.handle(new Request(`${host}/auth/.well-known/openid-configuration`));
      expect(((await res.json()) as { issuer: string }).issuer).toBe(`${host}/auth`);
    }
  });

  it("answers 421 to a host outside the list, whatever the forwarded headers say", async () => {
    const auth = createTwoHostAuth(harness());
    const res = await auth.handle(
      new Request("https://evil.example/auth/session", {
        headers: { "x-forwarded-host": "auth.example.com" },
      }),
    );
    expect(res.status).toBe(421);
    expect(await res.json()).toEqual({ error: "host_not_allowed" });
  });
});
