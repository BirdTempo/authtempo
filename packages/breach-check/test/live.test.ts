import { expect, it } from "vitest";
import { createBreachCheck } from "../src/index.js";

// The real range API. It runs only with AUTHTEMPO_LIVE_HIBP=1, and the
// evidence of a build does not count it.
const live =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    .AUTHTEMPO_LIVE_HIBP === "1";

it.runIf(live)("finds a common password and not a random one", async () => {
  const check = createBreachCheck();
  expect(await check("password")).toBe(true);
  expect(await check(crypto.randomUUID() + crypto.randomUUID())).toBe(false);
});
