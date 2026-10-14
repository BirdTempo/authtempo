import { createClient } from "@authtempo/client";

/**
 * The client of a CLI. The token is the `tk_…` value that the person copied
 * from the app once. `credentials: "omit"`: a CLI has no cookie jar.
 */
export function createCliClient(token: string, fetchImpl: typeof fetch = globalThis.fetch) {
  return createClient({
    baseURL: "https://api.example.com",
    credentials: "omit",
    token: () => token,
    fetch: fetchImpl,
  });
}
