/**
 * The fetch rules of the verifier (plan 11d).
 * Each call to the auth app follows no redirect, as every provider fetch of core does since plan 12b.
 * An answer must not steer the call to another address.
 * Each call has a deadline that the verifier owns.
 * So a hung auth app costs a resource server `timeoutMs`, not a hung request.
 */

/** The deadline of one call when the options name none. */
export const TIMEOUT_DEFAULT_MS = 5000;
/** The shortest deadline. A shorter one fails on a healthy network. */
export const TIMEOUT_MIN_MS = 100;
/** The longest deadline, as core's `password.legacyVerify.timeoutMs`. */
export const TIMEOUT_MAX_MS = 30_000;

/**
 * A fetch as the verifier calls it: one request, one response. Not `typeof fetch`: Bun's type
 * adds `preconnect`, which a handler such as `(input, init) => auth.handle(...)` has no use for,
 * and a cast in the app would also hide a wrong return type (plan 11d Task 14 review, M1).
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The fetch that every call of the verifier goes through.
 * A 3xx answer comes back with its status and no body, so the reader answers `unexpected` with that status.
 * A browser-like runtime gives an `opaqueredirect` answer under `redirect: "manual"`.
 * That answer has no status to pass on, so it rejects, and the reader answers `network` with status 0.
 */
export function ownedFetch(fetchFn: FetchLike, timeoutMs: number): FetchLike {
  return async (input, init) => {
    const res = await fetchFn(input, {
      ...init,
      redirect: "manual",
      // One deadline for the call and the read of its body.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.type === "opaqueredirect")
      throw new TypeError("authtempo verify: the auth app answered a redirect");
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return new Response(null, { status: res.status });
    }
    return res;
  };
}
