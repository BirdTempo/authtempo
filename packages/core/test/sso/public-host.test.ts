import { describe, expect, it } from "vitest";
import { validCimdUrl } from "../../src/engine/oauth-clients.js";
import { isPublicHost } from "../../src/primitives/host.js";

const BASE = "https://auth.example.com";

describe("the public-host rule (moved from oauth-clients.ts)", () => {
  it("refuses an IP literal, a local name, and this instance's own host, also with a trailing dot", () => {
    expect(isPublicHost("idp.acme.example", BASE)).toBe(true);
    expect(isPublicHost("cloudflare-dns.com", BASE)).toBe(true);
    for (const host of [
      "203.0.113.7",
      "[2001:db8::1]",
      "localhost",
      "intranet",
      "svc.corp.internal",
      "auth.example.com",
      "auth.example.com.",
      "printer.local.",
    ])
      expect(isPublicHost(host, BASE), host).toBe(false);
  });

  it("refuses a host with an empty label, so more trailing dots do not pass", () => {
    // One trailing dot names the same host and stays allowed.
    expect(isPublicHost("idp.acme.example.", BASE)).toBe(true);
    expect(validCimdUrl("https://idp.acme.example./client", BASE)).toBe(true);
    for (const host of [
      "a.internal...",
      "auth.example.com..",
      "a.example..com",
      "idp.acme.example..",
    ])
      expect(isPublicHost(host, BASE), host).toBe(false);
    for (const url of [
      "https://a.internal.../client",
      "https://auth.example.com../client",
      "https://a.example..com/client",
    ])
      expect(validCimdUrl(url, BASE), url).toBe(false);
  });
});
