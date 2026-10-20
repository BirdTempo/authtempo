/**
 * The one rule for the hosts that only this machine or a local network
 * serves (plan 12e, ruling 34). A client metadata document URL on such a
 * host is refused, and such a host is no pairwise sector. Each host here
 * is the parsed `URL.hostname`: the parser writes `127.1` and `0x7f.0.0.1`
 * as `127.0.0.1`, and `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`.
 */

/**
 * The loopback hosts of an http redirect URI: a subset of `isLocalHost`.
 * Not `[::1]`, because a CSP host-source has no IPv6 literal form. The
 * consent page cannot name it in `form-action`, and the browser would stop
 * at the allow. A client on the loopback uses 127.0.0.1.
 */
export const HTTP_LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/** A parsed IPv4 host. The URL parser writes every IPv4 form (`127.1`, `0x7f.0.0.1`) as four decimal parts. */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * True for an IP literal host, IPv4 or IPv6. Core takes no address as a
 * document host or as a pairwise sector (ruling 36 of plan 12e). An address
 * can change hands, and a private range is any local network's.
 */
export function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || IPV4_RE.test(hostname);
}

/** Host suffixes of names that only a local network resolves. A host equal to the name without its dot counts too. */
const PRIVATE_SUFFIXES: readonly string[] = [".local", ".home.arpa", ".internal"];
/** 127.0.0.0/8 and 0.0.0.0, the unspecified address, which reaches this machine. */
const LOOPBACK_V4_RE = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0)$/;
/**
 * `::1`, `::` (unspecified), and an IPv4-mapped or IPv4-compatible form of
 * 127.0.0.0/8 or 0.0.0.0, as the parser writes them.
 */
const LOOPBACK_V6_RE = /^\[(::1|::|::(ffff:)?(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0))\]$/;

/**
 * True for a host that only this machine or a local network serves. That is
 * a loopback or unspecified address in either IP form, `localhost`, and
 * `*.localhost` (RFC 6761 section 6.3). It is also a single label (an
 * intranet name), and the names `.local` (RFC 6762) and `.home.arpa`
 * (RFC 8375). `.internal` counts too: the ICANN private-use name of 2024.
 * A trailing dot names the same host, so it is ignored.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (LOOPBACK_V4_RE.test(host) || LOOPBACK_V6_RE.test(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // An IP literal other than a loopback one: the caller decides.
  if (host.startsWith("[")) return false;
  if (!host.includes(".")) return true;
  return PRIVATE_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
}

/**
 * The host rule of each URL that core fetches or posts to from the server.
 * No IP literal, no local name, and not the host of this instance.
 * `hostname` is the parsed `URL.hostname`. Plan 12d moved the rule here from
 * `oauth-clients.ts`, so the client documents and the DNS proofs share it.
 */
export function isPublicHost(hostname: string, baseURL: string): boolean {
  // A trailing dot names the same host: `localhost.` is `localhost`.
  const host = hostname.replace(/\.$/, "");
  // An IP literal (IPv4 or IPv6, 127.0.0.1 and [::1] too): a public client has a DNS name, and an address may be internal.
  if (isIpLiteral(host)) return false;
  // `localhost`, `*.localhost`, a single label, and the private names: the one local host rule.
  if (isLocalHost(host)) return false;
  // This instance's own host: a document there would make core fetch itself.
  // The compare is by `hostname`, with no port: a document on another port
  // of this host is refused too, which is stricter than the host and port.
  if (host === new URL(baseURL).hostname) return false;
  return true;
}
