/**
 * A provider answered a redirect (plan 12b). Core follows no redirect on a
 * server-side call to a provider: a provider endpoint must not steer the
 * request to an internal address. The flow answers `oauth_failed`, and the
 * log names this error and the status, never a URL.
 */
export class ProviderRedirectError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`authtempo: a provider answered a redirect (${status})`);
    this.name = "ProviderRedirectError";
    this.status = status;
  }
}

/**
 * The fetch of every provider call (plan 12b): `redirect: "manual"` over any
 * `init` the caller passes, also an app's `userinfo`, and a throw on a 3xx.
 * `opaqueredirect` is the answer a browser-like runtime gives under manual.
 */
export function providerFetch(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    const res = await fetchFn(input, { ...init, redirect: "manual" });
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect")
      throw new ProviderRedirectError(res.status);
    return res;
  };
}
