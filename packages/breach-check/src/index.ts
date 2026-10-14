/**
 * The HIBP Pwned Passwords range API behind core's `password.breachCheck`
 * (plan 12b). No runtime dependency. The facts are from the HIBP API v3
 * page, section "Pwned Passwords", read 2026-10-14. Only the first five
 * characters of the SHA-1 leave the process (k-anonymity).
 */

export const RANGE_URL = "https://api.pwnedpasswords.com/range/";
/** A padded answer has 800 to 1,000 lines of about 40 bytes. A larger body is not a true answer. */
export const BODY_MAX_BYTES = 65_536;

export interface BreachCheckOptions {
  /** Default: the global fetch. */
  fetch?: typeof fetch;
  /** 500 to 10000 ms. Default 2000. A late answer refuses the password with breach_check_unavailable. */
  timeoutMs?: number;
  /** A count of this or more refuses the password. Default 1. */
  minCount?: number;
  /** HIBP answers 403 to a request with no user agent. Default "authtempo-breach-check". */
  userAgent?: string;
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** The body as text, or null when it is longer than the cap. */
async function cappedText(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The error name only: never the password, the hash, or the prefix. */
const errorName = (e: unknown) => (e instanceof Error ? e.name : typeof e);

/**
 * The port function. It answers `true` when the password is in the range
 * answer with a count of `minCount` or more, `false` when it is not, and
 * `"unavailable"` when the range API gives no true answer: a timeout, a
 * network error, a status other than 200 (a 3xx too), or a body over
 * `BODY_MAX_BYTES`. Core then refuses the password with 503
 * `breach_check_unavailable`: the check fails closed.
 */
export function createBreachCheck(
  options: BreachCheckOptions = {},
): (plain: string) => Promise<boolean | "unavailable"> {
  const timeoutMs = options.timeoutMs ?? 2000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 10_000)
    throw new Error("authtempo breach-check: timeoutMs must be an integer from 500 to 10000");
  const minCount = options.minCount ?? 1;
  if (!Number.isSafeInteger(minCount) || minCount < 1)
    throw new Error("authtempo breach-check: minCount must be a positive integer");
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const userAgent = options.userAgent ?? "authtempo-breach-check";
  return async (plain) => {
    const hash = await sha1Hex(plain);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    let res: Response;
    try {
      res = await fetchFn(`${RANGE_URL}${prefix}`, {
        headers: { "Add-Padding": "true", "User-Agent": userAgent },
        // A redirect is no answer: a range endpoint must not send the call elsewhere.
        redirect: "manual",
        // One deadline for the call and the body read.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      console.error("authtempo breach-check: no answer", errorName(e));
      return "unavailable";
    }
    if (res.status !== 200) {
      console.error("authtempo breach-check: the range API answered", res.status);
      await res.body?.cancel().catch(() => {});
      return "unavailable";
    }
    let body: string | null;
    try {
      body = await cappedText(res);
    } catch (e) {
      console.error("authtempo breach-check: the body failed", errorName(e));
      return "unavailable";
    }
    if (body === null) {
      console.error("authtempo breach-check: the body is over the cap");
      return "unavailable";
    }
    for (const line of body.split("\n")) {
      const [s, c] = line.trim().split(":");
      const count = Number(c);
      // A line with count 0 is padding (the HIBP page): skip it.
      if (!s || !Number.isSafeInteger(count) || count === 0) continue;
      if (s.toUpperCase() === suffix) return count >= minCount;
    }
    return false;
  };
}
