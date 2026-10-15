/**
 * The client IP part of a per-IP limiter key (plan 12b Task 16). Every key of
 * the form `<flow>:ip:<value>` calls this function, so the rule has one copy.
 * The session row keeps the raw IP: only the limiter key uses this form.
 *
 * - `null` and `""` give `unknown`: one shared bucket for every caller with no IP.
 * - An IPv4 address in dotted form gives that form.
 * - An IPv4-mapped IPv6 address (`::ffff:0:0/96`, RFC 4291 section 2.5.5.2)
 *   gives its dotted IPv4 form, so the two forms of one host share one count.
 * - Any other IPv6 address gives its `/64` prefix, for example
 *   `2001:db8:1:2::/64`. SLAAC (RFC 4862) gives one host on a LAN a whole
 *   `/64`. A key per address lets that host use 2^64 keys.
 * - Any other value stays as it is: a custom `clientIp` can give any string.
 *
 * The cost: all users of one `/64` share each per-IP count. A host that gives
 * one `/64` to many tenants makes them share it. The NAT64 prefix
 * `64:ff9b::/96` is not a mapped address, so it keys by its `/64`.
 */
export function ipKey(ip: string | null): string {
  if (ip === null || ip === "") return "unknown";
  if (parseIpv4(ip) !== null) return ip;
  const groups = parseIpv6(ip);
  if (groups === null) return ip;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return [g >> 8, g & 0xff, h >> 8, h & 0xff].join(".");
  }
  return `${[a, b, c, d].map((x) => x.toString(16)).join(":")}::/64`;
}

const IPV4_PART = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_LITERAL = new RegExp(`^${IPV4_PART}(\\.${IPV4_PART}){3}$`);

/**
 * True for a bare IPv4 or IPv6 literal (plan 12a review L2). A client IP
 * header can carry any text the caller sends. The notice mail prints an IP
 * only in this form. The compat shim reads its listed headers by this rule
 * (review M-6). The URL parser checks the IPv6 form.
 */
export function isIpLiteral(value: string): boolean {
  if (IPV4_LITERAL.test(value)) return true;
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

/** The four octets of a dotted IPv4 address, or null. */
function parseIpv4(value: string): number[] | null {
  const m = IPV4.exec(value);
  if (m === null) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** The eight 16-bit groups of an IPv6 address, or null. No dependency. */
function parseIpv6(value: string): number[] | null {
  let s = value.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = expand(halves[0] ?? "", halves.length === 1);
  const tail = halves.length === 2 ? expand(halves[1] ?? "", true) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  // "::" stands for one or more zero groups.
  if (head.length + tail.length > 7) return null;
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** The groups of one side of "::". Only the last side can end in a dotted IPv4 tail. */
function expand(side: string, last: boolean): number[] | null {
  if (side === "") return [];
  const pieces = side.split(":");
  const groups: number[] = [];
  for (const [i, piece] of pieces.entries()) {
    if (last && i === pieces.length - 1 && piece.includes(".")) {
      const v4 = parseIpv4(piece);
      if (v4 === null) return null;
      const [o1 = 0, o2 = 0, o3 = 0, o4 = 0] = v4;
      groups.push((o1 << 8) | o2, (o3 << 8) | o4);
    } else if (HEX_GROUP.test(piece)) {
      groups.push(Number.parseInt(piece, 16));
    } else {
      return null;
    }
  }
  return groups.length > 8 ? null : groups;
}
