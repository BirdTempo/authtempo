import { describe, expect, it } from "vitest";
import { call, type Jar, lastCode, newSandbox, rowsIn } from "./helpers.js";

/** HMAC-SHA256 of `text` under the UTF-8 bytes of `secret`, in hex: the code hash of core (primitives/crypto.ts). */
async function hmacHex(secret: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(text));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The secret of the meta row, and the row id, stored hash, and mailed code of a new email code. */
async function codeOf(jar: Jar, email: string) {
  expect((await call(jar, "POST", "/auth/otp/request", { email })).status).toBe(200);
  const code = await lastCode(jar, email);
  const [row] = await rowsIn(
    jar,
    "SELECT id, value_hash FROM ta_verification WHERE identifier = ? ORDER BY created_at DESC LIMIT 1",
    email,
  );
  const [meta] = await rowsIn(jar, "SELECT value FROM demo_meta WHERE key = 'secret'");
  return { secret: String(meta?.value), id: String(row?.id), hash: String(row?.value_hash), code };
}

// Spec 24 item 11 and the Task 9 review of plan 11b, Low 3. Each sandbox has
// its own secret, and the auth of the sandbox reads it. Core stores an email
// code as HMAC-SHA256 under the app secret of "<row id>:<code>" (engine/email-otp.ts).
describe("the secret of a sandbox", () => {
  it("is the key of each code hash of that sandbox, and of no other", async () => {
    const a = await codeOf(await newSandbox(), "pat@example.com");
    const b = await codeOf(await newSandbox(), "pat@example.com");
    expect(a.secret).not.toBe(b.secret);
    expect(await hmacHex(a.secret, `${a.id}:${a.code}`)).toBe(a.hash);
    expect(await hmacHex(b.secret, `${b.id}:${b.code}`)).toBe(b.hash);
    expect(await hmacHex(b.secret, `${a.id}:${a.code}`)).not.toBe(a.hash);
  });
});
