import { describe, expect, it } from "vitest";
import { demoConfig } from "../src/auth.js";
import { DEMO_LIMITS } from "../src/facts.js";
import { createMailbox } from "../src/mailbox.js";
import { call, newSandbox, ORIGIN, PASSWORD, rowsIn } from "./helpers.js";

// Two rules of the demo that one line of src/auth.ts holds (final review m3
// of plan 11b). Each test fails when that line changes.
describe("the auth config of a sandbox", () => {
  it("trusts the demo origin only (spec 24 item 11)", async () => {
    const jar = await newSandbox();
    const other = await call(
      jar,
      "POST",
      "/auth/magic-link/request",
      { email: "pat@example.com" },
      { origin: "https://evil.example" },
    );
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: "origin_not_trusted" });
    // The same call from the demo origin passes, so the refusal is the origin rule.
    const own = await call(jar, "POST", "/auth/magic-link/request", { email: "pat@example.com" });
    expect(own.status).toBe(200);
  });

  it("hashes a password with 1000 PBKDF2 iterations (decision 4), as each password form says", async () => {
    const jar = await newSandbox();
    const up = await call(jar, "POST", "/auth/password/sign-up", {
      email: "pat@example.com",
      password: PASSWORD,
    });
    expect(up.status).toBe(200);
    // Core stores "pbkdf2-sha256$<iterations>$<salt>$<hash>" (seams/password-hash.ts).
    const rows = await rowsIn(jar, "SELECT hash FROM ta_password");
    expect(rows.map((r) => String(r.hash).split("$").slice(0, 2).join("$"))).toEqual([
      "pbkdf2-sha256$1000",
    ]);
  });

  it("ends each sandbox before the sliding refresh of core can renew a session cookie", () => {
    // Task 12 re-review, Low 3. Core renews the cookie after slidingRefreshDays,
    // 7 by default (packages/core/src/config.ts, resolveSessionConfig). The demo
    // sets no session block, so the default holds. No flow can then send the
    // renew line. When either value changes, the renew line must join a flow.
    const config = demoConfig({
      origin: ORIGIN,
      secret: `test-only-${"x".repeat(32)}`,
      db: {} as D1Database,
      mailbox: createMailbox({} as SqlStorage),
    });
    expect(config.session).toBeUndefined();
    expect(DEMO_LIMITS.sandboxLifeMs).toBeLessThan(7 * 86_400_000);
  });
});
