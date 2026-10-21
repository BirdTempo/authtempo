import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, resolveConfig } from "../src/config.js";
import {
  createKeyring,
  currentSecret,
  entropyBits,
  hashSecretFor,
  secretFor,
} from "../src/primitives/keyring.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { TEST_SECRET } from "../src/testing/soft-authenticator.js";
import { DEFAULT_OBSERVE } from "./helpers.js";

const HEX_128 = "0123456789abcdef0123456789abcdef";
// 43 characters of base64url from 32 random bytes (openssl rand -base64 32, then base64url).
const B64 = "q8JxVd3m0Yv2sZ7rKpT4wN1hLc9eFgAuBiOjQyRtSxM";
// 32 characters with 10 distinct ones: 32 x log2(10) = 106.3 bits.
const HEX_10 = "01234567890123456789012345678901";

function config(extra: Record<string, unknown>) {
  return resolveConfig({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    ...extra,
  } as Parameters<typeof resolveConfig>[0]);
}

const refusal = (extra: Record<string, unknown>) => {
  try {
    config(extra);
  } catch (e) {
    return e instanceof ConfigError ? e.message : `not a ConfigError: ${String(e)}`;
  }
  return "no refusal";
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("entropyBits (plan 12b)", () => {
  it("is the length times log2 of the distinct characters, in code points", () => {
    expect(entropyBits("x".repeat(32))).toBe(0);
    expect(entropyBits("ab".repeat(16))).toBe(32);
    expect(entropyBits(HEX_128)).toBe(128);
    expect(entropyBits("😀😁".repeat(16))).toBe(32);
  });
});

describe("the keyring (plan 12b)", () => {
  it("makes the first entry current and finds each value by its version only", () => {
    const k = createKeyring([
      { version: 2, value: "two" },
      { version: 1, value: "one" },
    ]);
    expect(k.current).toBe(2);
    expect(k.versions).toEqual([2, 1]);
    expect(currentSecret(k)).toBe("two");
    expect(k.valueOf(1)).toBe("one");
    expect(k.valueOf(3)).toBeNull();
  });

  it("answers null for a version that the config does not hold, with one log line that names the row only", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const k = createKeyring([{ version: 1, value: "one" }]);
    expect(secretFor(DEFAULT_OBSERVE, k, 9, "row-1")).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual([
      "authtempo: a stored value names secret version 9, which is not configured",
      "row-1",
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("one");
  });

  it("gives a keyed hash the current value and known false for an unknown version, so one HMAC still runs", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const k = createKeyring([
      { version: 2, value: "two" },
      { version: 1, value: "one" },
    ]);
    expect(hashSecretFor(DEFAULT_OBSERVE, k, 1, "r")).toEqual({ secret: "one", known: true });
    expect(hashSecretFor(DEFAULT_OBSERVE, k, 7, "r")).toEqual({ secret: "two", known: false });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("secret and secrets at construction (plan 12b)", () => {
  it("reads secret alone as version 1, the shape of today", () => {
    const c = config({ secret: HEX_128 });
    expect(c.keyring.current).toBe(1);
    expect(c.keyring.versions).toEqual([1]);
    expect(currentSecret(c.keyring)).toBe(HEX_128);
  });

  it("takes secrets with the current version first", () => {
    const c = config({
      secrets: [
        { version: 2, value: B64 },
        { version: 1, value: HEX_128 },
      ],
    });
    expect(c.keyring.current).toBe(2);
    expect(c.keyring.valueOf(1)).toBe(HEX_128);
  });

  it("adds secret as version 1 at the end when secrets has no version 1", () => {
    const c = config({ secret: HEX_128, secrets: [{ version: 2, value: B64 }] });
    expect(c.keyring.versions).toEqual([2, 1]);
    expect(c.keyring.current).toBe(2);
  });

  it("accepts secret and secrets that agree on version 1", () => {
    const c = config({
      secret: HEX_128,
      secrets: [
        { version: 1, value: HEX_128 },
        { version: 2, value: B64 },
      ],
    });
    expect(c.keyring.versions).toEqual([1, 2]);
  });

  it("refuses each malformed shape with the key in the message", () => {
    expect(refusal({})).toBe("secret or secrets is required");
    expect(refusal({ secret: 5 })).toBe("secret must be a string");
    expect(refusal({ secrets: [] })).toBe(
      "secrets must be a list of 1 or more { version, value } entries",
    );
    expect(refusal({ secrets: "x" })).toBe(
      "secrets must be a list of 1 or more { version, value } entries",
    );
    expect(refusal({ secrets: [null] })).toBe("secrets[0] must be an object");
    for (const version of [0, -1, 1.5, 1_000_000, "1"])
      expect(refusal({ secrets: [{ version, value: HEX_128 }] })).toBe(
        "secrets[0].version must be an integer from 1 to 999999",
      );
    expect(refusal({ secrets: [{ version: 1, value: 5 }] })).toBe(
      "secrets[0].value must be a string",
    );
    expect(refusal({ secrets: [{ version: 1, value: HEX_128, kid: "x" }] })).toBe(
      "secrets[0].kid is not an option; an entry has version and value",
    );
    expect(
      refusal({
        secrets: [
          { version: 1, value: HEX_128 },
          { version: 1, value: B64 },
        ],
      }),
    ).toBe("secrets has version 1 twice");
    expect(
      refusal({
        secrets: [
          { version: 2, value: HEX_128 },
          { version: 1, value: HEX_128 },
        ],
      }),
    ).toBe("secrets has one value under two versions; each version needs its own value");
    expect(refusal({ secret: HEX_128, secrets: [{ version: 1, value: B64 }] })).toBe(
      "secret and secrets version 1 hold different values; give the old secret once, as version 1",
    );
  });

  it("refuses a value shorter than 32 characters, by its path", () => {
    expect(refusal({ secret: "short" })).toBe("secret must be at least 32 characters");
    expect(
      refusal({
        secrets: [
          { version: 2, value: B64 },
          { version: 1, value: "short" },
        ],
      }),
    ).toBe("secrets[1].value must be at least 32 characters");
  });

  it("refuses a current secret under 100 bits, and the message holds no value", () => {
    const repeated = refusal({ secret: "x".repeat(32) });
    expect(repeated).toBe(
      "secret has an estimated 0 bits of entropy; at least 100 are required. Make a new one with 32 random bytes, for example: openssl rand -base64 32",
    );
    expect(refusal({ secret: "ab".repeat(16) })).toContain("secret has an estimated 32 bits");
    expect(
      refusal({
        secrets: [
          { version: 2, value: "ab".repeat(16) },
          { version: 1, value: HEX_128 },
        ],
      }),
    ).toContain("secrets[0] has an estimated 32 bits");
    expect(repeated).not.toContain("xxxx");
  });

  it("passes a 43-character base64url secret and a 32-character hex secret with no log line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    config({ secret: B64 });
    config({ secret: HEX_128 });
    config({ secret: TEST_SECRET });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once for a current secret from 100 to 119 bits", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    config({ secret: HEX_10 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "authtempo: secret has an estimated 106 bits of entropy; 120 or more is recommended",
    );
  });

  it("warns, and does not refuse, for a weak old version: a refusal would block the move away from it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = config({
      secrets: [
        { version: 2, value: B64 },
        { version: 1, value: "x".repeat(32) },
      ],
    });
    expect(c.keyring.current).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "authtempo: secrets[1] has an estimated 0 bits of entropy; 120 or more is recommended",
    );
  });
});
