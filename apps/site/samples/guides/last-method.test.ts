import { describe, expect, it } from "vitest";
import { call, harness, linkIn } from "../support/harness.ts";
import { createLastMethodAuth, lastMethodOf } from "./last-method.ts";

describe("the last method cookie", () => {
  it("names the method of the last browser sign-in, in a cookie that a script reads", async () => {
    const h = harness();
    const auth = createLastMethodAuth(h);
    await call(auth, "POST", "/auth/magic-link/request", { email: "ada@example.com" });
    const token = linkIn(h, "ada@example.com").searchParams.get("token") ?? "";
    const res = await call(auth, "POST", "/auth/magic-link/verify", { token });
    const line =
      res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_last_method=")) ?? "";
    expect(line).not.toContain("HttpOnly");
    expect(lastMethodOf(line.split(";")[0] ?? "")).toBe("magic_link");
    expect(((await res.json()) as { via: string }).via).toBe("magic_link");
  });

  it("sets no cookie for a bearer client", async () => {
    const auth = createLastMethodAuth(harness());
    await call(auth, "POST", "/auth/password/sign-up", {
      email: "bo@example.com",
      password: "correct horse battery",
    });
    const res = await call(
      auth,
      "POST",
      "/auth/password/sign-in",
      { email: "bo@example.com", password: "correct horse battery" },
      { authorization: "Bearer ts_unknown" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.includes("tempo_last_method"))).toBe(false);
  });
});
