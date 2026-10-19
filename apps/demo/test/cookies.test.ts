import { beforeAll, describe, expect, it } from "vitest";
import { type Cookie, parseCookie } from "./cookie-rules.js";
import { everyFlow } from "./flows.js";
import { SET_COOKIES } from "./helpers.js";

let cookies: Cookie[] = [];

// The cookie rule of the demo (plan 11b, deviation 3), over each Set-Cookie
// line of every flow. Each test also needs the names it reads, so a flow that
// sets no cookie fails here and does not pass on an empty list.
describe("the cookies of the demo", () => {
  beforeAll(async () => {
    await everyFlow();
    cookies = SET_COOKIES.map(parseCookie);
  });

  it("reads a cookie of each kind", () => {
    expect([...new Set(cookies.map((c) => c.name))].sort()).toEqual([
      "__Host-demo_sandbox",
      "__Host-tempo_session",
      "__Secure-tempo_session_oauth",
      "tempo_totp_trust",
    ]);
  });

  it("sets no cookie with a Domain", () => {
    expect(cookies.filter((c) => c.attrs.has("domain")).map((c) => c.line)).toEqual([]);
  });

  it("sets every cookie Secure and HttpOnly", () => {
    const weak = cookies.filter((c) => !c.attrs.has("secure") || !c.attrs.has("httponly"));
    expect(weak.map((c) => c.line)).toEqual([]);
  });

  it("sets the sandbox cookie and the session cookie with __Host- and Path=/", () => {
    for (const name of ["__Host-demo_sandbox", "__Host-tempo_session"]) {
      const lines = cookies.filter((c) => c.name === name);
      expect(lines.length).toBeGreaterThan(0);
      for (const c of lines)
        expect({ line: c.line, path: c.attrs.get("path") }).toEqual({ line: c.line, path: "/" });
    }
    // RFC 6265bis 4.1.3.2: a browser drops a __Host- cookie with another path.
    const hosts = cookies.filter((c) => c.name.startsWith("__Host-"));
    expect(hosts.filter((c) => c.attrs.get("path") !== "/").map((c) => c.line)).toEqual([]);
  });

  it("sets the path cookies of core with no __Host- prefix", () => {
    // The social binding cookie and the trusted-device cookie (deviation 3).
    const paths = new Map(
      cookies.filter((c) => c.attrs.get("path") !== "/").map((c) => [c.name, c.attrs.get("path")]),
    );
    expect(Object.fromEntries(paths)).toEqual({
      "__Secure-tempo_session_oauth": "/auth/social",
      tempo_totp_trust: "/auth/",
    });
  });
});
