import { isIP } from "node:net";
import { Stop } from "./errors.js";
import { describeUrl } from "./output.js";

// The transport rule of design section 9 item 4 (plan 12g Task 6). A
// connection to a host that is not a loopback address goes over TLS with
// certificate checks. A password or a token never crosses a network in
// plain text. The MySQL seam and the libSQL seam check it before they
// connect. The Postgres seam has no such rule yet (plan 12g, deviation 10):
// it is an open point for the owner.

/**
 * True for `localhost`, an IPv4 address in 127.0.0.0/8, and each form of
 * `::1`, such as `0:0:0:0:0:0:0:1`. A URL host `[::1]` keeps its brackets.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost" || h === "::1") return true;
  if (h.includes(":")) {
    // WHATWG URL writes an IPv6 address in its shortest form, so each form of
    // ::1 reads as [::1]. The libSQL parser keeps the form of the URL. The
    // whole URL must equal http://[::1]/. Host text such as ::1]#x closes the
    // bracket early and adds a part after it, so it is no address.
    try {
      return new URL(`http://[${h}]/`).href === "http://[::1]/";
    } catch {
      return false;
    }
  }
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 === null) return false;
  return v4.slice(1).every((n) => Number(n) <= 255);
}

/**
 * The `ssl` query value of a mysql2 URL as mysql2 reads it: JSON when it
 * parses, else the text. TLS with certificate checks is an object with
 * `rejectUnauthorized` true and `verifyIdentity` true. Without
 * `verifyIdentity`, mysql2 3.24.5 checks the chain but not the host name
 * (lib/base/connection.js:430-451, read 2026-10-21). A text is an SSL
 * profile name of mysql2, which this rule does not take.
 */
function mysqlChecksCertificate(ssl: string | null): boolean {
  if (ssl === null) return false;
  let value: unknown;
  try {
    value = JSON.parse(ssl);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const o = value as { rejectUnauthorized?: unknown; verifyIdentity?: unknown };
  return o.rejectUnauthorized === true && o.verifyIdentity === true;
}

/** The first query key that occurs more than once in `keys`, or null. */
function repeatedKey(keys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
}

/**
 * The parts of a URL that a driver can print alone. They are the password,
 * its decoded form, and each `authToken` query value. A libSQL client reads
 * its token from that query too. A seam adds each part to the scrub list
 * before its first line.
 */
export function urlSecrets(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const parts = [u.password, ...u.searchParams.getAll("authToken")];
  try {
    parts.push(decodeURIComponent(u.password));
  } catch {
    // A malformed escape: the raw form is in the list already.
  }
  return parts.filter((p) => p.length > 0);
}

/**
 * A libSQL URL as the driver reads it: the parts that `expandConfig` of
 * `@libsql/core` answers, and the query keys of its own URL parser. The
 * SQLite seam makes it, so this module names no driver. The WHATWG URL
 * parser reads some URLs in another way: it takes a backslash as a slash,
 * and the first of two equal keys, not the last.
 */
export interface LibsqlTarget {
  /** `http`, `https`, `ws`, `wss`, or `file`. A `libsql:` URL is `https` or `http` here. */
  scheme: string;
  tls: boolean;
  /** The host the driver connects to, with no brackets; null when the URL has no authority. */
  host: string | null;
  /** Each query key, in order, with each repeat. */
  queryKeys: string[];
}

/** The two URL schemes of a libSQL server with TLS, after `expandConfig`. */
const LIBSQL_TLS = new Set(["https", "wss"]);
/** The URL schemes of a libSQL server over a network, after `expandConfig`. */
const LIBSQL_SCHEMES = new Set(["http", "ws", ...LIBSQL_TLS]);

/**
 * The host of a MySQL URL as mysql2 3.24.5 reads it: the WHATWG URL host
 * with no brackets, then decoded (lib/connection_config.js:334-340, read
 * 2026-11-03). So the rule judges the host that the driver connects to:
 * mysql2 reads `203%2E0%2E113%2E9` as the IP address 203.0.113.9.
 */
function mysqlHost(u: URL): string {
  const h = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  try {
    return decodeURIComponent(h);
  } catch {
    throw new Stop("the host of the connection string of mysql has a malformed % escape");
  }
}

/**
 * Stops the run before any connection when a MySQL `url` would send a
 * secret in plain text to a host that is not a loopback address. The URL
 * needs `?ssl=` with a JSON object whose `rejectUnauthorized` and
 * `verifyIdentity` are true. A host that is an IP address and not a
 * loopback address also stops the run, because mysql2 cannot check its
 * name. mysql2 reads its URL with WHATWG URL, as this rule does. The
 * message names the host by `describeUrl`, never the user, the password,
 * or the query.
 */
export function requireMysqlTransport(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Stop("the connection string of mysql is not a URL");
  }
  if (u.protocol !== "mysql:")
    throw new Stop(`the connection string of mysql starts with mysql://, not ${u.protocol}//`);
  // mysql2 keeps the last of two equal keys, and this rule reads the first.
  if (repeatedKey([...u.searchParams.keys()]) !== null)
    throw new Stop("the connection string of mysql has a query key more than once");
  const host = mysqlHost(u);
  if (isLoopbackHost(host)) return;
  // A remote host needs TLS with verifyIdentity, but mysql2 cannot check the
  // name of an IP host. mysql2 3.24.5 sends no server name when
  // net.isIP(host) is not 0 (lib/base/connection.js:431-433). Node then
  // checks the certificate against the name localhost, not the IP (seen
  // 2026-11-03). So a certificate for localhost passes at any IP, and a
  // certificate for the IP fails. test/transport-identity.test.ts holds
  // this fact of mysql2.
  if (isIP(host) !== 0)
    throw new Stop(
      `the host of ${describeUrl(url)} is an IP address that is not a loopback address; the MySQL driver sends no server name to an IP host and checks the name localhost in its place; use the DNS name that the certificate carries`,
    );
  if (mysqlChecksCertificate(u.searchParams.get("ssl"))) return;
  throw new Stop(
    `${describeUrl(url)} is not a loopback host, and the URL asks for no TLS with certificate and host name checks; add ?ssl={"rejectUnauthorized":true,"verifyIdentity":true}`,
  );
}

/**
 * Stops the run before any connection when a libSQL `url` would send a
 * token in plain text to a host that is not a loopback address. `parse`
 * gives the URL as the driver reads it, and the rule judges that: the
 * scheme is `https` or `wss` with TLS on. The run also stops on a URL that
 * WHATWG URL reads in another way, which holds a backslash or a repeated
 * query key. A SQLite file takes `--file`, not a URL. The message names the
 * host by `describeUrl`, never the token or the query.
 */
export function requireLibsqlTransport(url: string, parse: (url: string) => LibsqlTarget): void {
  // WHATWG URL reads a backslash as a slash, and the libSQL parser does not,
  // so the two find other hosts. No libSQL URL needs a backslash.
  if (url.includes("\\")) throw new Stop("the libSQL URL has a backslash; remove it");
  const t = parse(url);
  if (repeatedKey(t.queryKeys) !== null)
    throw new Stop("the libSQL URL has a query key more than once");
  if (t.scheme === "file") throw new Stop("a SQLite file takes --file <path>, not a file: URL");
  if (!LIBSQL_SCHEMES.has(t.scheme))
    throw new Stop(`the libSQL URL starts with libsql://, https://, or wss://, not ${t.scheme}://`);
  if (t.host !== null && isLoopbackHost(t.host)) return;
  if (LIBSQL_TLS.has(t.scheme) && t.tls) return;
  throw new Stop(
    `${describeUrl(url)} is not a loopback host, and the URL asks for no TLS; use https:// or libsql:// with TLS`,
  );
}
