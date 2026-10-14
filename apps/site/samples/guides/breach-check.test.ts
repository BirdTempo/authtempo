import { afterEach, describe, expect, it, vi } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createBreachCheckAuth } from "./breach-check.ts";

/** A range API stub that gives one answer and counts the calls. No test calls the network. */
function stubRange(answer: () => Response): { calls: number } {
  const seen = { calls: 0 };
  vi.stubGlobal("fetch", async () => {
    seen.calls++;
    return answer();
  });
  return seen;
}

describe("a breach check on the password", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the policy first, so a short password costs no call to the range API", async () => {
    const range = stubRange(() => new Response("0000000000000000000000000000000000A:0\n"));
    const auth = createBreachCheckAuth(harness());
    const short = await call(auth, "POST", "/auth/password/sign-up", {
      email: "ada@example.com",
      password: "short",
    });
    expect(await short.json()).toEqual({ error: "password_policy" });
    expect(range.calls).toBe(0);
  });

  it("fails closed: an outage or a page that is not a range refuses the password with 503", async () => {
    for (const answer of [
      () => new Response("down", { status: 503 }),
      () => new Response("<html>sign in to the network</html>", { status: 200 }),
    ]) {
      const range = stubRange(answer);
      const auth = createBreachCheckAuth(harness());
      const res = await call(auth, "POST", "/auth/password/sign-up", {
        email: "ada@example.com",
        password: "correct horse battery",
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "breach_check_unavailable" });
      expect(range.calls).toBe(1);
    }
  });
});
