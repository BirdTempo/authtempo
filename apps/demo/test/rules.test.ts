import { describe, expect, it } from "vitest";
import { call, newSandbox, PASSWORD, rowsIn } from "./helpers.js";

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
});
