import { describe, expect, it } from "vitest";
import { normalizeDomain } from "../../src/engine/sso/domains.js";

describe("the SSO domains", () => {
  it("normalizes a domain to its A-label form", () => {
    expect(normalizeDomain("Bücher.Example")).toBe("xn--bcher-kva.example");
    expect(normalizeDomain("ACME.Example")).toBe("acme.example");
    expect(normalizeDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    expect(normalizeDomain("mail.eu.acme.example")).toBe("mail.eu.acme.example");
    const refused: unknown[] = [
      "1.2.3.4",
      "localhost",
      "a.example.",
      "*.a.example",
      "a b.example",
      // The characters of a URL part, and a control character.
      "a/b.example",
      "a:1.example",
      "u@a.example",
      "a\tb.example",
      // The URL parser maps these to another host: an IPv4 form, a percent escape, a full-width letter, an ideographic dot.
      "0x7f.1",
      "a%2eb.example",
      "\uff45xample.com",
      "a\u3002example",
      // An ideographic dot after an A-label: one given label, two mapped labels.
      "xn--bcher-kva\u3002example",
      // The URL parser reads a last label of digits as an IPv4 part, and throws.
      "example.123",
      // A label that no host name holds.
      "a_b.example",
      "-a.example",
      "a..example",
      `${"a".repeat(64)}.example`,
      "[::1]",
      "",
      ` acme.example`,
      `${"a.".repeat(126)}ab`,
      // 231 characters in Unicode, 255 in A-labels.
      `${`${"ü".repeat(55)}.`.repeat(4)}example`,
      7,
      null,
    ];
    for (const raw of refused) expect(normalizeDomain(raw), JSON.stringify(raw)).toBeNull();
  });
});
