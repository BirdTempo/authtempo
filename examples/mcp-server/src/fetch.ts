/**
 * The guarded fetch for client metadata documents (`oauth.fetch` of core).
 *
 * A client id of an MCP client can be the https URL of its metadata document,
 * so core fetches a URL that a stranger chose. This fetch refuses a host whose
 * name resolves to a private address (server-side request forgery).
 *
 * Two platform facts, read 2026-10-17:
 * - A Worker fetches by URL, not by IP address
 *   (developers.cloudflare.com/workers/platform/known-issues/, "Fetch to IP addresses").
 *   No page says that Workers refuse a name that resolves to a private address.
 *   So the app owns this guard, and the guard does not rely on the platform.
 * - A fetch to the Worker's own host, without the flag global_fetch_strictly_public,
 *   goes to the zone's origin and skips every Worker on the URL. With the flag, it can
 *   loop back to the same Worker
 *   (developers.cloudflare.com/workers/configuration/compatibility-flags/, read 2026-10-17).
 *   So a Verifier with a JWKS URL on its own host is the one case that the flag changes.
 *   This example sets no global_fetch_strictly_public, and core refuses its own host as a client id.
 *
 * The gap: the name can answer another address at the connect than at this check
 * (DNS rebinding). Workers give no way to pin the address of a fetch. So core's own
 * host rules, `redirect: "manual"`, the 10-second timeout, and the 64 KB cap stay the
 * first line, and this check is the second.
 */

/** What the guard needs: a name lookup and the fetch that sends the request. */
export interface GuardDeps {
  /** Every A and AAAA answer of a name. An empty list means no address. */
  resolve(name: string): Promise<string[]>;
  fetch: typeof fetch;
}

/**
 * The private IPv4 classes. Source: RFC 6890 sections 2.2.2 (each block has
 * "Global: False", read 2026-10-17), and RFC 5771 for multicast, which RFC 6890 does not list.
 * One line for each class.
 */
const PRIVATE_V4: readonly (readonly [base: string, bits: number])[] = [
  ["0.0.0.0", 8], // "This host on this network"
  ["10.0.0.0", 8], // Private-Use
  ["100.64.0.0", 10], // Shared Address Space (carrier-grade NAT)
  ["127.0.0.0", 8], // Loopback
  ["169.254.0.0", 16], // Link Local, with the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12], // Private-Use
  ["192.0.0.0", 24], // IETF Protocol Assignments
  ["192.168.0.0", 16], // Private-Use
  ["198.18.0.0", 15], // Benchmarking
  ["224.0.0.0", 4], // Multicast (RFC 5771)
  ["240.0.0.0", 4], // Reserved, with the limited broadcast 255.255.255.255
];

/** The IPv4 address as an unsigned 32-bit number, or null. Only four decimal parts, no leading zero. */
function parseV4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function isPrivateV4(address: number): boolean {
  return PRIVATE_V4.some(([base, bits]) => {
    const start = parseV4(base);
    if (start === null) return true;
    const size = 2 ** (32 - bits);
    return Math.floor(address / size) === Math.floor(start / size);
  });
}

/** The IPv6 address as eight 16-bit groups, or null. A dotted IPv4 tail is allowed. */
function parseV6(text: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  let body = text;
  const tail: number[] = [];
  if (body.includes(".")) {
    const at = body.lastIndexOf(":");
    const v4 = parseV4(body.slice(at + 1));
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 65536), v4 % 65536);
    body = body.slice(0, at + 1);
    // "::ffff:" keeps no trailing colon; "::" stays as it is.
    if (!body.endsWith("::")) body = body.slice(0, -1);
  }
  const groupsOf = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const halves = body.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const all = groupsOf(body);
    return all !== null && all.length + tail.length === 8 ? [...all, ...tail] : null;
  }
  const head = groupsOf(halves[0] ?? "");
  const rest = groupsOf(halves[1] ?? "");
  if (head === null || rest === null) return null;
  const missing = 8 - head.length - rest.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest, ...tail];
}

function isPrivateV6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const zeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroHead && g5 === 0 && g6 === 0 && g7 === 0) return true; // :: (RFC 6890, unspecified)
  if (zeroHead && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1 (RFC 6890, loopback)
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 (RFC 6890, unique local)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 (RFC 6890, link local)
  // ::ffff:0:0/96, the IPv4-mapped form: the IPv4 address decides.
  if (zeroHead && g5 === 0xffff) return isPrivateV4(g6 * 65536 + g7);
  return false;
}

/**
 * True when the address is in no private class. A text that is no IPv4 or
 * IPv6 address is not public: the guard refuses what it cannot read.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseV4(address);
  if (v4 !== null) return !isPrivateV4(v4);
  if (!address.includes(":")) return false;
  const v6 = parseV6(address);
  return v6 !== null && !isPrivateV6(v6);
}

/** DNS record types of the dns-json answer (RFC 1035 and RFC 3596). */
const TYPE_A = 1;
const TYPE_AAAA = 28;

/**
 * A lookup of the A and AAAA answers through Cloudflare's DNS over HTTPS
 * (`https://cloudflare-dns.com/dns-query` with `accept: application/dns-json`).
 * A Worker has no other name lookup.
 */
export function dohResolve(fetchFn: typeof fetch): (name: string) => Promise<string[]> {
  const ask = async (name: string, type: "A" | "AAAA", code: number): Promise<string[]> => {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", name);
    url.searchParams.set("type", type);
    const res = await fetchFn(url, {
      headers: { accept: "application/dns-json" },
      redirect: "manual",
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error("the DNS lookup of the client metadata host failed");
    }
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return [];
    const answer = (body as { Answer?: unknown }).Answer;
    if (!Array.isArray(answer)) return [];
    // A CNAME line has another type. Its target's address comes as its own line.
    return answer
      .filter((a): a is { type: number; data: string } => {
        const r = a as { type?: unknown; data?: unknown };
        return r.type === code && typeof r.data === "string";
      })
      .map((a) => a.data);
  };
  return async (name) => {
    const [a, aaaa] = await Promise.all([ask(name, "A", TYPE_A), ask(name, "AAAA", TYPE_AAAA)]);
    return [...a, ...aaaa];
  };
}

/** The lookup, or a rejection when the caller's signal aborts first (core's 10-second timeout). */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (signal === null) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    work.then(resolve, reject);
  });
}

/**
 * A fetch for `oauth.fetch` that sends a request only to an https host whose
 * every address is public. Wire it as `guardedFetch({ resolve: dohResolve(fetch), fetch })`.
 */
export function guardedFetch(deps: GuardDeps): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:") throw new Error("the client metadata URL must be https");
    // A trailing dot names the same host. Brackets hold an IPv6 literal.
    const host = url.hostname.replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");
    const literal = parseV4(host) !== null || host.includes(":");
    const addresses = literal ? [host] : await untilAbort(deps.resolve(host), request.signal);
    if (addresses.length === 0) throw new Error("the client metadata host has no address");
    if (!addresses.every(isPublicAddress))
      throw new Error("the client metadata host resolves to a private address");
    // Core sets redirect manual too (spec 8.13). A redirect must not lead past this check.
    return deps.fetch(new Request(request, { redirect: "manual" }));
  };
}
