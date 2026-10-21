import { describe, expect, it } from "vitest";
import { CONTROL, FIELD_KINDS, keyedHash, REJECT, scrub, secretParts } from "../src/redact.js";

describe("the redaction source (plan 12h Task 1, spec 31 item 9)", () => {
  // The rows of packages/cli/test/secrets.test.ts:87 and :88, plus one row
  // whose set holds the short secret first, so only the sort gives `***`.
  it("scrubs each secret, the longest first", () => {
    const rows = [
      {
        text: "pw and u:pw",
        secrets: new Set(secretParts("postgres://u:pw@h/d")),
        out: "pw and ***",
      },
      { text: "u:pw12 and pw12", secrets: new Set(["pw12", "u:pw12"]), out: "*** and ***" },
      // One secret twice in a line, with no overlap: each one goes.
      { text: "s3cret s3cret", secrets: new Set(["s3cret"]), out: "*** ***" },
    ];
    for (const { text, secrets, out } of rows) expect(scrub(text, secrets), text).toBe(out);
  });

  it("splits a URL secret into its parts", () => {
    expect(secretParts("postgres://u:pw@h/d")).toEqual(["postgres://u:pw@h/d", "u:pw"]);
    expect(secretParts("postgres://u:p%40ss@h/db")).toEqual([
      "postgres://u:p%40ss@h/db",
      "p%40ss",
      "p@ss",
      "u:p%40ss",
    ]);
    expect(secretParts("abc")).toEqual([]);
  });

  it("matches each C0 control character but tab, and DEL", () => {
    expect(CONTROL.flags).toContain("g");
    for (const c of ["\u0000", "\u001b", "\u007f", "\n"]) expect(c.replace(CONTROL, "?")).toBe("?");
    expect("\t".replace(CONTROL, "?")).toBe("\t");
    expect("a\u001bb".replace(CONTROL, "?")).toBe("a?b");
  });

  it("keeps a plain error class name and drops any other", () => {
    for (const name of ["TypeError", "JWTExpired", "AbortError", "string", "A".repeat(64)])
      expect(FIELD_KINDS.errorClass(name)).toBe(name);
    expect(FIELD_KINDS.errorClass("Bad name: a@b.c")).toBe("Error");
    expect(FIELD_KINDS.errorClass("A".repeat(65))).toBe("Error");
  });

  it("applies the appErrorName rule", () => {
    expect(FIELD_KINDS.errorName("TypeError")).toBe("TypeError");
    expect(FIELD_KINDS.errorName("JWTExpired")).toBe("Error");
    // A thrown value that is no Error logs as its typeof (plan 12h ruling 1, point 3).
    expect(FIELD_KINDS.errorName("string")).toBe("string");
    // A name of 64 characters stays; a name of 65 writes Error, so the field has a bound.
    expect(FIELD_KINDS.errorName(`${"A".repeat(59)}Error`)).toBe(`${"A".repeat(59)}Error`);
    expect(FIELD_KINDS.errorName(`${"A".repeat(60)}Error`)).toBe("Error");
  });

  it("rejects a value that fails its kind", () => {
    expect(FIELD_KINDS.hash("x")).toBe(REJECT);
    expect(FIELD_KINDS.count(-1)).toBe(REJECT);
    expect(FIELD_KINDS.count(1.5)).toBe(REJECT);
    expect(FIELD_KINDS.name("Google")).toBe(REJECT);
    expect(FIELD_KINDS.identifier("a b")).toBe(REJECT);
    expect(FIELD_KINDS.id("a".repeat(65))).toBe(REJECT);
    expect(FIELD_KINDS.route("r".repeat(129))).toBe(REJECT);
    expect(FIELD_KINDS.hash("0123456789abcdef0123456789abcdef")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(FIELD_KINDS.status(404)).toBe(404);
    expect(FIELD_KINDS.durationMs(-1)).toBe(REJECT);
    expect(FIELD_KINDS.durationMs(1.5)).toBe(REJECT);
    expect(FIELD_KINDS.durationMs("5")).toBe(REJECT);
    expect(FIELD_KINDS.durationMs(5)).toBe(5);
  });

  it("derives a keyed hash of 32 hex that depends on the secret and the info", async () => {
    const secret = "s".repeat(32);
    const info = "authtempo observe ip v1";
    const value = "203.0.113.7";
    const hash = await keyedHash(secret, info, value);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(await keyedHash(secret, info, value)).toBe(hash);
    expect(await keyedHash("t".repeat(32), info, value)).not.toBe(hash);
    expect(await keyedHash(secret, "authtempo observe email v1", value)).not.toBe(hash);

    // The known vector: HKDF-SHA-256 with an empty salt gives 32 bytes, and
    // HMAC-SHA-256 under those bytes signs the value.
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
      base,
      256,
    );
    const key = await crypto.subtle.importKey(
      "raw",
      bits,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
    const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    expect(hash).toBe(expected);
  });
});
