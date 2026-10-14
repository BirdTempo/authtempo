import { createHandoff, type HandoffOpener } from "@authtempo/handoff";

/**
 * The app side. In Expo the opener is `expoOpener(WebBrowser)` and the crypto
 * is `expoCrypto(Crypto)` from `@authtempo/handoff/expo`. In Electron the
 * opener is `electronOpener({ shell, app })` from `@authtempo/handoff/electron`.
 */
export function createAppHandoff(
  opener: HandoffOpener,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  return createHandoff({
    baseURL: "https://api.example.com",
    // `<scheme>auth` for the scheme `myapp://` of the API's handoff.schemes.
    redirect: "myapp://auth",
    opener,
    fetch: fetchImpl,
  });
}
