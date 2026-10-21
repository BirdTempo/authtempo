import { Stop } from "./errors.js";
import { describeUrl } from "./output.js";

// The transport rule of design section 9 item 4 (plan 12g Task 6). A
// connection to a host that is not a loopback address goes over TLS with
// certificate checks. A password or a token never crosses a network in
// plain text. The MySQL seam and the libSQL seam check it before they
// connect. The Postgres seam has no such rule yet (plan 12g, deviation 10):
// it is an open point for the owner.

/** True for `localhost`, an IPv4 address in 127.0.0.0/8, and `::1`. A URL host `[::1]` keeps its brackets. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost" || h === "::1") return true;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 === null) return false;
  return v4.slice(1).every((n) => Number(n) <= 255);
}

/**
 * The `ssl` query value of a mysql2 URL as mysql2 reads it: JSON when it
 * parses, else the text. TLS with certificate checks is an object whose
 * `rejectUnauthorized` is not false (mysql2 then sets it to true). A text is
 * an SSL profile name of mysql2, which this rule does not take.
 */
function mysqlChecksCertificate(ssl: string | null): boolean {
  if (ssl === null) return false;
  let value: unknown;
  try {
    value = JSON.parse(ssl);
  } catch {
    return false;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { rejectUnauthorized?: unknown }).rejectUnauthorized !== false
  );
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

/** The URL schemes that a libSQL client takes over a network, and the ones with TLS. */
const LIBSQL_SCHEMES = new Set(["libsql:", "https:", "wss:", "http:", "ws:"]);
const LIBSQL_TLS = new Set(["libsql:", "https:", "wss:"]);

/**
 * Stops the run before any connection when `url` would send a secret in
 * plain text to a host that is not a loopback address. MySQL:
 * the URL needs `?ssl=` with a JSON object whose `rejectUnauthorized` is not
 * false. libSQL: the URL is `https:`, `wss:`, or `libsql:` with TLS on.
 * A SQLite file takes `--file`, not a URL. Each message names the host by
 * `describeUrl`, never the user, the password, or the query.
 */
export function requireTransport(url: string, kind: "mysql" | "libsql"): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Stop(`the connection string of ${kind} is not a URL`);
  }
  const at = describeUrl(url);
  if (kind === "mysql") {
    if (u.protocol !== "mysql:")
      throw new Stop(`the connection string of mysql starts with mysql://, not ${u.protocol}//`);
    if (isLoopbackHost(u.hostname) || mysqlChecksCertificate(u.searchParams.get("ssl"))) return;
    throw new Stop(
      `${at} is not a loopback host, and the URL asks for no TLS with certificate checks; add ?ssl={"rejectUnauthorized":true}`,
    );
  }
  if (u.protocol === "file:") throw new Stop("a SQLite file takes --file <path>, not a file: URL");
  if (!LIBSQL_SCHEMES.has(u.protocol))
    throw new Stop(
      `the libSQL URL starts with libsql://, https://, or wss://, not ${u.protocol}//`,
    );
  if (isLoopbackHost(u.hostname)) return;
  // @libsql/client 0.18.0 (lib-esm/config.js, read 2026-10-21) reads a libsql:
  // URL as TLS unless it has a `tls` value other than "1".
  const tls = u.searchParams.get("tls");
  if (LIBSQL_TLS.has(u.protocol) && (u.protocol !== "libsql:" || tls === null || tls === "1"))
    return;
  throw new Stop(
    `${at} is not a loopback host, and the URL asks for no TLS; use https:// or libsql:// with TLS`,
  );
}
