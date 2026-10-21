import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exampleConfig } from "../src/app.js";

// The host gate of TEST_READINESS (plan 12h Task 9, ruling 8). Each base below
// parses to a host other than localhost and 127.0.0.1.
const REMOTE_BASES = [
  "https://example.test",
  "http://localhost.evil.com",
  "http://127.0.0.1.nip.io",
  "http://[::1]:8787",
  "http://localhost.:8787",
];

// The env of the test pool with another BASE_URL and TEST_READINESS.
function withReadiness(base: string, mode: string): Env {
  return { ...(env as unknown as Env), BASE_URL: base, TEST_READINESS: mode };
}

describe("the TEST_READINESS gate of the example (plan 12h Task 9)", () => {
  for (const mode of ["on", "store_down"]) {
    for (const base of REMOTE_BASES) {
      it(`ignores TEST_READINESS ${mode} when BASE_URL is ${base}`, async () => {
        const config = exampleConfig(withReadiness(base, mode));
        expect("observe" in config).toBe(false);
        // The storage is over env.DB: its ping reads the schema version there.
        await expect(config.storage.ping?.()).resolves.toBeUndefined();
      });
    }
  }

  for (const base of ["http://localhost", "http://127.0.0.1"]) {
    it(`mounts the readiness route for TEST_READINESS on when BASE_URL is ${base}`, async () => {
      const config = exampleConfig(withReadiness(base, "on"));
      expect(config.observe?.readiness).toBe(true);
      await expect(config.storage.ping?.()).resolves.toBeUndefined();
    });

    it(`stops the storage for TEST_READINESS store_down when BASE_URL is ${base}`, async () => {
      const config = exampleConfig(withReadiness(base, "store_down"));
      expect(config.observe?.readiness).toBe(true);
      await expect(config.storage.ping?.()).rejects.toThrow();
    });
  }
});
