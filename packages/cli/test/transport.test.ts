import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, Socket } from "node:net";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Stop } from "../src/errors.js";
import { describeUrl } from "../src/output.js";
import { openMysql } from "../src/seams/mysql.js";
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
// tests, with no connection. One test counts the sockets of the MySQL seam,
// and only its control case connects, to a closed port of 127.0.0.1.

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

/** The Stop of the MySQL rule for a host that is not a loopback address and a URL with no TLS. */
const noTls = (where: string) =>
  `${where} is not a loopback host, and the URL asks for no TLS with certificate and host name checks; add ?ssl={"rejectUnauthorized":true,"verifyIdentity":true}`;

/** The error of one ping through the MySQL seam of the CLI, or null when it passes. */
async function seamError(url: string): Promise<unknown> {
  try {
    const seam = openMysql(url, () => {});
    try {
      await seam.ping();
    } finally {
      await seam.close();
    }
    return null;
  } catch (e) {
    return e;
  }
}

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

  it("refuses a MySQL host that is an IP address and not a loopback address, even with TLS", () => {
    // mysql2 3.24.5 checks the name localhost for an IP host, so no host name check holds there.
    const tls = '{"rejectUnauthorized":true,"verifyIdentity":true}';
    const ipStop = (where: string) =>
      `the host of ${where} is an IP address that is not a loopback address; the MySQL driver sends no server name to an IP host and checks the name localhost in its place; use the DNS name that the certificate carries`;
    const hosts: [host: string, where: string][] = [
      ["203.0.113.9", "203.0.113.9/db"],
      ["[2001:db8::7]", "[2001:db8::7]/db"],
      // The rule reads an IPv4-mapped address as no loopback address. This one
      // reaches 127.0.0.1: the identity case of transport-identity.test.ts
      // connects through it. On Linux, net.ipv6.bindv6only=1 fails that
      // connect with ENETUNREACH, and disable_ipv6=1 does not (probe in
      // node:26.10.0 linux/arm64 containers, 2026-11-03).
      ["[::ffff:127.0.0.1]", "[::ffff:7f00:1]/db"],
      // mysql2 decodes the host, so it reads this host as the IP 203.0.113.9.
      ["203%2E0%2E113%2E9", "203%2E0%2E113%2E9/db"],
    ];
    for (const [host, where] of hosts)
      for (const query of ["", "?ssl=true", `?ssl=${tls}`])
        expect(
          stopOf(() => requireMysqlTransport(`mysql://u:p@${host}/db${query}`)),
          host + query,
        ).toBe(ipStop(where));
    // A loopback address needs no TLS. A DNS name passes with TLS and its checks.
    for (const host of ["127.0.0.1", "[::1]", "[0:0:0:0:0:0:0:1]", "127%2E0%2E0%2E1"])
      expect(() => requireMysqlTransport(`mysql://u:p@${host}/db`), host).not.toThrow();
    expect(() => requireMysqlTransport(`mysql://u:p@db.example.com/db?ssl=${tls}`)).not.toThrow();
    // mysql2 cannot decode this host, so the rule cannot judge it.
    expect(stopOf(() => requireMysqlTransport(`mysql://u:p@db%ZZ.example/db?ssl=${tls}`))).toBe(
      "the host of the connection string of mysql has a malformed % escape",
    );
  });

  it("refuses a MySQL host with a tab, LF, or CR before the loopback read, and opens no socket (review of the Task 6 fix of plan 12n, L1)", async () => {
    // WHATWG URL drops each of the three, so without the check ::<tab>1 reads as ::1.
    for (const h of ["::\t1", "::\n1", "::1\r", "[::\t1]", "0:0:0:0:0:0:0:\t1"])
      expect(isLoopbackHost(h), JSON.stringify(h)).toBe(false);
    // mysql2 decodes the host %3A%3A%091 to ::<tab>1.
    const url = "mysql://u:p@%3A%3A%091/db";
    expect(stopOf(() => requireMysqlTransport(url))).toBe(noTls("%3A%3A%091/db"));
    const connect = vi.spyOn(Socket.prototype, "connect");
    try {
      // The control case: mysql2 connects to a closed port of 127.0.0.1, and the spy counts it.
      const closed = createServer();
      await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
      const address = closed.address();
      await new Promise<void>((done) => closed.close(() => done()));
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const loopback = await seamError(`mysql://u:p@127.0.0.1:${port}/db`);
      expect(loopback instanceof Stop ? loopback.message : loopback).toBe(
        `storage: ECONNREFUSED at 127.0.0.1:${port}/db`,
      );
      expect(connect).toHaveBeenCalledTimes(1);
      // The seam stops the tab host before mysql2 opens a socket.
      const refused = await seamError(url);
      expect(refused instanceof Stop ? refused.message : refused).toBe(noTls("%3A%3A%091/db"));
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      connect.mockRestore();
    }
  });

  it("reads an IPv4 octet with a leading zero as no loopback address (the whole-branch review of plan 12n, open point 4)", () => {
    // net.isIP gives 0 for each of these, so the rule asks for TLS, as for a name.
    for (const h of ["127.0.0.08", "127.0.0.010", "127.000.000.001", "127.01.0.1"])
      expect(isLoopbackHost(h), h).toBe(false);
    expect(stopOf(() => requireMysqlTransport("mysql://u:p@127.0.0.08/db"))).toBe(
      noTls("127.0.0.08/db"),
    );
    // An octet 0, and an octet that ends in 0, stay in the rule.
    for (const h of ["127.0.0.0", "127.0.10.100"]) expect(isLoopbackHost(h), h).toBe(true);
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

  it("reads each long form of ::1 as loopback, and no other IPv6 address", () => {
    // The libSQL parser keeps the form of the URL, so the rule reads each form.
    for (const h of ["[0:0:0:0:0:0:0:1]", "0:0:0:0:0:0:0:1", "[0::1]", "0::1", "[0:0::0:1]"])
      expect(isLoopbackHost(h), h).toBe(true);
    // An IPv4-mapped address is no form of ::1, so the rule asks for TLS there.
    for (const h of ["[0:0:0:0:0:0:0:2]", "[::ffff:127.0.0.1]", "::ffff:7f00:1", "[fe80::1%25en0]"])
      expect(isLoopbackHost(h), h).toBe(false);
    // Host text with more after ::1 is no address, and neither is text before it.
    for (const h of ["::1]#x", "::1]/x", "::1]?x", "[x@[::1]", "x@[::1"])
      expect(isLoopbackHost(h), h).toBe(false);
    expect(() => libsql("http://[0:0:0:0:0:0:0:1]:8080")).not.toThrow();
    expect(() => libsql("ws://[0::1]:8080")).not.toThrow();
    expect(stopOf(() => libsql("http://[0:0:0:0:0:0:0:2]:8080"))).toContain("TLS");
    // The libSQL parser decodes the host of these URLs to ::1]#x and ::1]/x.
    for (const url of ["http://[::1%5D%23x]:8080", "http://[::1%5D%2Fx]:8080"])
      expect(
        stopOf(() => libsql(url)),
        url,
      ).toContain("TLS");
  });
});
