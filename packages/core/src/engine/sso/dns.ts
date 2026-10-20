import { readCapped } from "../../primitives/read-capped.js";
import { PROVIDER_TIMEOUT_MS } from "../../social/provider.js";

/**
 * The DNS port of the domain proof (plan 12d, spec 30 item 3). `txt` answers
 * the TXT strings at `name`, each with its parts joined, `[]` when the name
 * does not exist, or null when the resolver gives no usable answer. A port
 * binds its fetch at construction (deviation 9 of the plan). Core has no
 * default resolver (ruling 15 of plan 12d): an app passes its ports, and
 * `dohCloudflare` and `dohGoogle` are presets that it may pick.
 */
export interface DnsTxtPort {
  name: string;
  txt(name: string): Promise<string[] | null>;
}

/** The body cap of one DoH answer. A TXT answer for one challenge name is far smaller. */
export const DOH_BODY_MAX = 16_384;

/** The DNS RR type of TXT (RFC 1035 section 3.2.2). */
const TYPE_TXT = 16;
/** The DNS response codes that the adapters read (RFC 1035 section 4.1.1). */
const RCODE_NOERROR = 0;
const RCODE_NXDOMAIN = 3;

/**
 * The preset resolver of Cloudflare, through its DoH JSON API
 * (developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/,
 * read 2026-10-20). The page follows the schema of Google's JSON API.
 */
export function dohCloudflare(fetchFn: typeof fetch): DnsTxtPort {
  return dohJson("cloudflare", "https://cloudflare-dns.com/dns-query", fetchFn);
}

/**
 * The preset resolver of Google, through its DoH JSON API
 * (developers.google.com/speed/public-dns/docs/doh/json, read 2026-10-20).
 */
export function dohGoogle(fetchFn: typeof fetch): DnsTxtPort {
  return dohJson("google", "https://dns.google/resolve", fetchFn);
}

/**
 * One DoH JSON resolver. The answer is null on a fetch error, a status other
 * than 200 (also a redirect: core follows none), a body past
 * `DOH_BODY_MAX`, a body that is not JSON of the read form, no answer in
 * `PROVIDER_TIMEOUT_MS`, or a `Status` other than NOERROR and NXDOMAIN.
 */
function dohJson(portName: string, endpoint: string, fetchFn: typeof fetch): DnsTxtPort {
  return {
    name: portName,
    async txt(name) {
      const ctrl = new AbortController();
      // setTimeout, not AbortSignal.timeout: a test moves it with fake timers.
      const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS);
      try {
        let res: Response;
        try {
          res = await fetchFn(`${endpoint}?name=${encodeURIComponent(name)}&type=TXT`, {
            headers: { accept: "application/dns-json" },
            redirect: "manual",
            signal: ctrl.signal,
          });
        } catch {
          return null;
        }
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        const text = await readCapped(res, DOH_BODY_MAX, ctrl.signal);
        if (text === null) return null;
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return null;
        }
        return txtStrings(body, name);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The TXT strings of a DoH JSON answer for `name`, or null when the answer
 * is not of the read form. Each `Answer` entry of type 16 gives one string.
 * An entry of another type (a CNAME, an RRSIG) is skipped, and so is an
 * entry of another owner name: the strings of a CNAME target are not the
 * strings of `name`.
 */
function txtStrings(body: unknown, name: string): string[] | null {
  if (!isRecord(body) || typeof body.Status !== "number") return null;
  if (body.Status === RCODE_NXDOMAIN) return [];
  if (body.Status !== RCODE_NOERROR) return null;
  // NOERROR with no Answer: the name exists and has no TXT record.
  if (body.Answer === undefined) return [];
  if (!Array.isArray(body.Answer)) return null;
  const asked = ownerName(name);
  const out: string[] = [];
  for (const entry of body.Answer) {
    if (!isRecord(entry) || typeof entry.type !== "number") return null;
    if (entry.type !== TYPE_TXT) continue;
    if (typeof entry.name !== "string" || typeof entry.data !== "string") return null;
    if (ownerName(entry.name) !== asked) continue;
    const value = joinedTxt(entry.data);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

/** A DNS name in one form for a compare: lowercase, with no trailing dot (RFC 4343: names compare with no case). */
function ownerName(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

/**
 * The value of one TXT record from its `data` text, or null. The JSON form
 * quotes each character-string: Google writes `"a""b"`, and Cloudflare's
 * presentation format writes `"a" "b"`. Inside a part, `\"` and `\\` are
 * escapes. Any other text, also another escape such as `\065`, is outside
 * the read form, so the answer is null and the proof fails closed. The parts
 * join with nothing between them, as RFC 7208 section 3.3 joins them.
 */
function joinedTxt(data: string): string | null {
  let out = "";
  let parts = 0;
  let i = 0;
  while (i < data.length) {
    if (data[i] === " ") {
      i++;
      continue;
    }
    if (data[i] !== '"') return null;
    i++;
    for (;;) {
      const c = data[i];
      if (c === undefined) return null;
      i++;
      if (c === '"') break;
      if (c === "\\") {
        const e = data[i];
        if (e !== '"' && e !== "\\") return null;
        out += e;
        i++;
        continue;
      }
      out += c;
    }
    parts++;
  }
  return parts === 0 ? null : out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
