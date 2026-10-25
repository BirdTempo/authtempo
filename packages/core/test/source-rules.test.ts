import { describe, expect, it } from "vitest";

/**
 * The two node:fs calls of the scan. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck (ip-key-sites.test.ts).
 */
interface SourceFs {
  readdirSync(dir: URL, options: { recursive: true }): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

/**
 * The assertion forms that turn a nullable address into a string (plan 12i
 * Task 1). A user can have no address from schema version 15, so a read
 * of an address takes a guard (`hasAddress`), never an assertion.
 */
const ASSERTIONS = [".email!", "email as string", ".email as string"];

/** The SMS suppliers and SDKs that core must not name (plan 12i Task 4), in lower case. */
const SUPPLIERS = ["twilio", "vonage", "nexmo", "messagebird", "plivo", "sinch", "aws-sdk"];

describe("the source rules of plan 12i", () => {
  it("no assertion on an address", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../src/", import.meta.url);
    const files = readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".ts"));
    // The scan must read the files that read an address: a list with no file finds no hit.
    expect(files).toContain("engine/users.ts");
    expect(files).toContain("engine/address.ts");
    const hits = files.flatMap((file) => {
      const text = readFileSync(new URL(file, src), "utf8");
      return ASSERTIONS.filter((form) => text.includes(form)).map((form) => `${file}: ${form}`);
    });
    expect(hits).toEqual([]);
  });

  it("names no SMS supplier in core", async () => {
    // The SMS port is supplier-free (plan 12i Global Constraints): an app
    // brings its supplier through `phone.sms`, and no core file names one.
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../src/", import.meta.url);
    const files = readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".ts"));
    expect(files).toContain("seams/sms.ts");
    expect(files).toContain("engine/phone.ts");
    const hits = files.flatMap((file) => {
      const text = readFileSync(new URL(file, src), "utf8").toLowerCase();
      return SUPPLIERS.filter((name) => text.includes(name)).map((name) => `${file}: ${name}`);
    });
    expect(hits).toEqual([]);
  });

  it("sends every SMS through the one counted send (plan 12i Task 5)", async () => {
    // The daily cap is a promise of core (ruling 20 of plan 12i). A call of
    // the port outside `countedSend` would send a text that the cap does not count.
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../src/", import.meta.url);
    const files = readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".ts"));
    const calls = files.flatMap((file) => {
      const text = readFileSync(new URL(file, src), "utf8");
      return [...text.matchAll(/\.sms\.send\(/g)].map(() => file);
    });
    expect(calls).toEqual(["engine/phone.ts"]);
    const phone = readFileSync(new URL("../src/engine/phone.ts", import.meta.url), "utf8");
    const at = phone.indexOf(".sms.send(");
    const body = phone.slice(phone.indexOf("async function countedSend("), at);
    expect(body).toContain('limit(config, "phone-otp:all-day"');
    // The note and the code reach the port through it only.
    expect(phone.match(/countedSend\(config, /g)).toHaveLength(2);
  });

  it("opens no session outside the gate (plan 12i Task 15)", async () => {
    // A session opens through prepareSession or openSession. Each file that
    // calls one is a pathway with a decision in the gate table
    // (gate-table.test.ts). The phone code and the ID-token sign-in pass the
    // gate of 12c, so they open sessions only through gatedSteps.
    // The rule works per file: a new open in a listed file passes it. That
    // is a recorded residual. The gate table rows cover the sign-ins in
    // password.ts and passkeys.ts.
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../src/", import.meta.url);
    const files = readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".ts"));
    expect(files).toContain("engine/phone.ts");
    expect(files).toContain("engine/id-token.ts");
    const openers = files
      .filter((file) => file !== "engine/sessions.ts")
      .filter((file) =>
        /\b(prepareSession|openSession)\(/.test(readFileSync(new URL(file, src), "utf8")),
      )
      .sort();
    expect(openers).not.toContain("engine/phone.ts");
    expect(openers).not.toContain("engine/id-token.ts");
    expect(openers).toEqual([
      // The anonymous sign-in: no factor can be on (ANONYMOUS_REFUSED).
      "engine/anonymous.ts",
      // The handoff redeem: the code comes from a session that passed its gate.
      "engine/handoff.ts",
      // An impersonation: an operator act, never a way in.
      "engine/operator/impersonation.ts",
      // The passkey sign-in and the passkey-first sign-up: two factors in one.
      "engine/passkeys.ts",
      // The password gate itself, the sign-up, the verify link, and the reset.
      "engine/password.ts",
      // gatedSteps: the session after a gate that passed or was off.
      "engine/second-factor.ts",
      // The verify of a challenge.
      "engine/totp.ts",
    ]);
  });

  it("checks a phone code through the one compare of the email code", async () => {
    // compareCode runs one keyed HMAC and one constant-time compare on every
    // path. A second compare in the phone code would drift from it.
    const { readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const phone = readFileSync(new URL("../src/engine/phone.ts", import.meta.url), "utf8");
    expect(phone).toContain("return compareCode(");
    expect(phone).not.toMatch(/valueHash|constantTimeEqual|===\s*input\.code/);
    const otp = readFileSync(new URL("../src/engine/email-otp.ts", import.meta.url), "utf8");
    expect(otp).toContain("constantTimeEqual(candidate, row?.valueHash ?? NO_ROW_HASH)");
  });
});
