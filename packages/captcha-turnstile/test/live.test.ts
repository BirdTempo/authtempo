import { expect, it } from "vitest";
import { createTurnstileCaptcha } from "../src/index.js";

// The real siteverify with Cloudflare's test secret, which accepts only the
// dummy token (the Turnstile testing page, read 2026-10-14). It runs only with
// AUTHTEMPO_LIVE_TURNSTILE=1, and the evidence of a build does not count it.
const live =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    .AUTHTEMPO_LIVE_TURNSTILE === "1";

it.runIf(live)("passes the dummy token under the always-pass test secret", async () => {
  const port = createTurnstileCaptcha({ secretKey: "1x0000000000000000000000000000000AA" });
  expect(
    await port.verify({ token: "XXXX.DUMMY.TOKEN.XXXX", ip: null, flow: "password-sign-up" }),
  ).toBe("pass");
});
