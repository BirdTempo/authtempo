import { describe, expect, it } from "vitest";
import { Stop } from "../src/errors.js";
import { describeUrl } from "../src/output.js";
import { isLoopbackHost, requireTransport, urlSecrets } from "../src/transport.js";

// The transport rule of design section 9 item 4 (plan 12g Task 6): pure
// tests, with no connection.

/** The message of the Stop that `f` throws. It fails when `f` throws no Stop. */
function stopOf(f: () => void): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(Stop);
    return (e as Stop).message;
  }
  throw new Error("no Stop was thrown");
}

describe("requireTransport (plan 12g Task 6)", () => {
  it("requires TLS for a MySQL host that is not a loopback address", () => {
    const plain = stopOf(() => requireTransport("mysql://u:p4ss@db.example.com/app", "mysql"));
    expect(plain).toContain("TLS");
    expect(plain).toContain("db.example.com/app");
    expect(plain).not.toContain("p4ss");
    expect(() =>
      requireTransport('mysql://u:p@db.example.com/app?ssl={"rejectUnauthorized":true}', "mysql"),
    ).not.toThrow();
    expect(() => requireTransport("mysql://u:p@db.example.com/app?ssl={}", "mysql")).not.toThrow();
    for (const host of ["127.0.0.1", "127.8.9.10", "[::1]", "localhost"])
      expect(() => requireTransport(`mysql://u:p@${host}:3306/app`, "mysql")).not.toThrow();
    // A query ssl that turns the certificate check off is no TLS with checks.
    expect(
      stopOf(() =>
        requireTransport(
          'mysql://u:p@db.example.com/app?ssl={"rejectUnauthorized":false}',
          "mysql",
        ),
      ),
    ).toContain("TLS");
    // A text is a mysql2 profile name, and true is no object: neither is taken.
    for (const ssl of ["Amazon%20RDS", "true"])
      expect(
        stopOf(() => requireTransport(`mysql://u:p@db.example.com/app?ssl=${ssl}`, "mysql")),
      ).toContain("TLS");
    expect(stopOf(() => requireTransport("postgres://u:p@localhost/app", "mysql"))).toBe(
      "the connection string of mysql starts with mysql://, not postgres://",
    );
  });

  it("requires https or libsql for a remote libSQL URL", () => {
    expect(stopOf(() => requireTransport("http://db.example.com", "libsql"))).toContain("TLS");
    expect(stopOf(() => requireTransport("ws://db.example.com", "libsql"))).toContain("TLS");
    // @libsql/client reads a libsql: URL with tls=0, or any tls value but 1, as plain text.
    for (const tls of ["0", "no"])
      expect(
        stopOf(() => requireTransport(`libsql://db.example.com:8080?tls=${tls}`, "libsql")),
      ).toContain("TLS");
    for (const url of [
      "https://db.example.com",
      "wss://db.example.com",
      "libsql://db.example.com",
      "libsql://db.example.com?tls=1",
      "http://127.0.0.1:8089",
      "http://localhost:8089",
    ])
      expect(() => requireTransport(url, "libsql"), url).not.toThrow();
    expect(stopOf(() => requireTransport("file:./auth.db", "libsql"))).toBe(
      "a SQLite file takes --file <path>, not a file: URL",
    );
  });

  it("drops the query string and the password from the description", () => {
    expect(describeUrl("libsql://db.example.com/app?authToken=abc")).toBe("db.example.com/app");
    expect(describeUrl("mysql://u:p@h:3306/app?ssl=x")).toBe("h:3306/app");
  });

  it("names the password and each authToken of a URL for the scrub list", () => {
    expect(urlSecrets("mysql://u:p%40ss@h:3306/app")).toEqual(["p%40ss", "p@ss"]);
    expect(urlSecrets("libsql://db.example.com/app?authToken=tok1&authToken=tok2")).toEqual([
      "tok1",
      "tok2",
    ]);
    expect(urlSecrets("not a url")).toEqual([]);
  });

  it("reads 127.0.0.0/8, ::1, and localhost as loopback, and nothing else", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.255.255.255", "::1", "[::1]"])
      expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["127.0.0.256", "128.0.0.1", "10.0.0.1", "db.example.com", "::2", "127.1"])
      expect(isLoopbackHost(h), h).toBe(false);
  });
});
