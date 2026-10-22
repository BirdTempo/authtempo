import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Stop } from "../src/errors.js";
import { describeUrl } from "../src/output.js";
import { libsqlParser } from "../src/seams/sqlite.js";
import {
  isLoopbackHost,
  type LibsqlTarget,
  requireLibsqlTransport,
  requireMysqlTransport,
  urlSecrets,
} from "../src/transport.js";
import { PKG } from "./support/bin.js";

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

/** The libSQL parser of the seam: the parser of the driver. */
let parse: (url: string) => LibsqlTarget;
beforeAll(async () => {
  parse = await libsqlParser();
});
const libsql = (url: string) => requireLibsqlTransport(url, parse);

describe("the transport rule (plan 12g Task 6)", () => {
  it("requires TLS for a MySQL host that is not a loopback address", () => {
    const plain = stopOf(() => requireMysqlTransport("mysql://u:p4ss@db.example.com/app"));
    expect(plain).toContain("TLS");
    expect(plain).toContain("db.example.com/app");
    expect(plain).not.toContain("p4ss");
    expect(() =>
      requireMysqlTransport(
        'mysql://u:p@db.example.com/app?ssl={"rejectUnauthorized":true,"verifyIdentity":true}',
      ),
    ).not.toThrow();
    for (const host of ["127.0.0.1", "127.8.9.10", "[::1]", "localhost"])
      expect(() => requireMysqlTransport(`mysql://u:p@${host}:3306/app`)).not.toThrow();
    // A query ssl that turns the certificate check off is no TLS with checks.
    expect(
      stopOf(() =>
        requireMysqlTransport(
          'mysql://u:p@db.example.com/app?ssl={"rejectUnauthorized":false,"verifyIdentity":true}',
        ),
      ),
    ).toContain("TLS");
    // A text is a mysql2 profile name, and true is no object: neither is taken.
    for (const ssl of ["Amazon%20RDS", "true"])
      expect(
        stopOf(() => requireMysqlTransport(`mysql://u:p@db.example.com/app?ssl=${ssl}`)),
      ).toContain("TLS");
    expect(stopOf(() => requireMysqlTransport("postgres://u:p@localhost/app"))).toBe(
      "the connection string of mysql starts with mysql://, not postgres://",
    );
  });

  it("requires the host name check of mysql2 for a remote MySQL host", () => {
    // Without verifyIdentity, mysql2 3.24.5 takes any host name on a valid chain.
    for (const ssl of ["{}", '{"rejectUnauthorized":true}', '{"verifyIdentity":false}'])
      expect(
        stopOf(() => requireMysqlTransport(`mysql://u:p@db.example.com/app?ssl=${ssl}`)),
        ssl,
      ).toBe(
        'db.example.com/app is not a loopback host, and the URL asks for no TLS with certificate and host name checks; add ?ssl={"rejectUnauthorized":true,"verifyIdentity":true}',
      );
  });

  it("refuses a MySQL URL with a query key more than once", () => {
    // mysql2 keeps the last ssl, so the second one would turn the checks off.
    const ssl = '{"rejectUnauthorized":true,"verifyIdentity":true}';
    expect(
      stopOf(() =>
        requireMysqlTransport(
          `mysql://u:p@db.example.com/app?ssl=${ssl}&ssl={"rejectUnauthorized":false}`,
        ),
      ),
    ).toBe("the connection string of mysql has a query key more than once");
  });

  it("requires https or libsql for a remote libSQL URL", () => {
    expect(stopOf(() => libsql("http://db.example.com"))).toContain("TLS");
    expect(stopOf(() => libsql("ws://db.example.com"))).toContain("TLS");
    // @libsql/client reads a libsql: URL with tls=0 as plain text.
    expect(stopOf(() => libsql("libsql://db.example.com:8080?tls=0"))).toContain("TLS");
    // The driver refuses any tls value but 0 and 1, so the run stops on its code.
    expect(stopOf(() => libsql("libsql://db.example.com:8080?tls=no"))).toBe(
      "the libSQL URL is not valid: URL_INVALID",
    );
    for (const url of [
      "https://db.example.com",
      "wss://db.example.com",
      "libsql://db.example.com",
      "libsql://db.example.com?tls=1",
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "ws://[::1]:8080",
    ])
      expect(() => libsql(url), url).not.toThrow();
    expect(stopOf(() => libsql("file:./auth.db"))).toBe(
      "a SQLite file takes --file <path>, not a file: URL",
    );
  });

  it("refuses a libSQL URL with a query key more than once", () => {
    // WHATWG URL reads the first tls, 1. The driver reads the last, 0, and goes plain.
    expect(stopOf(() => libsql("libsql://evil.example:8080?tls=1&tls=0"))).toBe(
      "the libSQL URL has a query key more than once",
    );
    expect(parse("libsql://evil.example:8080?tls=1&tls=0")).toEqual({
      scheme: "http",
      tls: false,
      host: "evil.example",
      queryKeys: ["tls", "tls"],
    });
  });

  it("refuses a libSQL URL with a backslash", () => {
    // WHATWG URL reads host 127.0.0.1; the driver reads host evil.example.
    expect(stopOf(() => libsql("ws://127.0.0.1\\@evil.example/"))).toBe(
      "the libSQL URL has a backslash; remove it",
    );
    expect(stopOf(() => libsql("ws://127.0.0.1:8080\\@localhost:9/"))).toBe(
      "the libSQL URL has a backslash; remove it",
    );
    expect(parse("ws://127.0.0.1\\@evil.example/")).toMatchObject({
      scheme: "ws",
      host: "evil.example",
    });
  });

  it("judges the URL as the driver reads it, not as WHATWG URL reads it", () => {
    const as = (t: Omit<LibsqlTarget, "queryKeys">) => () => ({ ...t, queryKeys: [] });
    expect(
      stopOf(() =>
        requireLibsqlTransport(
          "https://db.example.com",
          as({ scheme: "http", tls: false, host: "db.example.com" }),
        ),
      ),
    ).toContain("TLS");
    expect(
      stopOf(() =>
        requireLibsqlTransport(
          "http://127.0.0.1:8080",
          as({ scheme: "http", tls: false, host: "evil.example" }),
        ),
      ),
    ).toContain("TLS");
    expect(() =>
      requireLibsqlTransport(
        "http://db.example.com",
        as({ scheme: "https", tls: true, host: "db.example.com" }),
      ),
    ).not.toThrow();
  });

  it("reads the URL with the @libsql/core copy of @libsql/client", () => {
    // Two copies of @libsql/core could parse one URL in two ways: the rule
    // would judge one host, and the driver would connect to another.
    const cli = createRequire(join(PKG, "package.json"));
    const client = createRequire(realpathSync(cli.resolve("@libsql/client")));
    for (const entry of ["@libsql/core/config", "@libsql/core/uri"])
      expect(realpathSync(cli.resolve(entry)), entry).toBe(realpathSync(client.resolve(entry)));
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
