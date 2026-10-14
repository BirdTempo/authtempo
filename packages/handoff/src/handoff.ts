import { type ClientCode, createClient } from "@authtempo/client";
import type { PublicSession } from "@authtempo/core";
import { HANDOFF_CALLS } from "./calls.js";
import { type HandoffCrypto, makePkce, webCrypto } from "./pkce.js";
import { parseReturnedUrl } from "./redirect.js";

export interface HandoffOpener {
  /**
   * Opens `url` in the system browser and resolves with the full URL the app
   * received on `redirect`, or null when the person cancelled or the wait
   * ended. It must not resolve with a URL from another flow.
   */
  open(url: string, redirect: string): Promise<string | null>;
}

export type HandoffCode = ClientCode | "redirect_mismatch";
export interface HandoffFailure {
  ok: false;
  code: HandoffCode;
  status: number;
}
export type HandoffSession = { token: string } & PublicSession;
export type HandoffResult = { ok: true; value: HandoffSession } | HandoffFailure;

export interface HandoffOptions {
  baseURL: string;
  basePath?: string | undefined;
  /** `<scheme>auth`, where `<scheme>` is an entry of the API's `handoff.schemes` with its `://`, such as `consumera://auth`. Or the loopback URL the API's `devRedirectPattern` admits. */
  redirect: string;
  opener: HandoffOpener;
  fetch?: typeof fetch | undefined;
  crypto?: HandoffCrypto | undefined;
}

export interface Handoff {
  /** One full sign-in: start URL to the opener, the returned code redeemed with this call's verifier. */
  signIn(): Promise<HandoffResult>;
  /** The start URL for a given challenge; exposed for apps that open the browser themselves. */
  startUrl(challenge: string): string;
}

function encode(s: string): string {
  return encodeURIComponent(s);
}

/**
 * One sign-in is one PKCE pair. The verifier stays in this function's frame
 * and leaves the process once, in the redeem body. The returned URL must sit
 * on the configured redirect, or no redeem happens.
 */
export function createHandoff(options: HandoffOptions): Handoff {
  const basePath = options.basePath ?? "/auth";
  const c = options.crypto ?? webCrypto();
  // A trailing slash on baseURL would build `//auth/handoff/start`, which the router answers with 404.
  const baseURL = options.baseURL.replace(/\/$/, "");
  const client = createClient({
    baseURL,
    basePath,
    credentials: "omit",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const startPath = HANDOFF_CALLS[0].path;
  const startUrl = (challenge: string) =>
    `${baseURL}${basePath}${startPath}?challenge=${encode(challenge)}&redirect=${encode(options.redirect)}`;
  async function run(): Promise<HandoffResult> {
    const { verifier, challenge } = await makePkce(c);
    const returned = await options.opener.open(startUrl(challenge), options.redirect);
    if (returned === null) return { ok: false, code: "cancelled", status: 0 };
    const parsed = parseReturnedUrl(options.redirect, returned);
    if (!parsed.ok) return { ok: false, code: "redirect_mismatch", status: 0 };
    const code = parsed.params.code;
    if (!code) return { ok: false, code: "unexpected", status: 0 };
    return client.handoff.redeem({ code, verifier });
  }
  // Single flight. On Expo a second openAuthSessionAsync call can reject while the first session is open, and signIn must not reject for a platform event.
  // A second caller gets the first call's result. The slot clears when the call ends.
  let inFlight: Promise<HandoffResult> | null = null;
  return {
    startUrl,
    signIn() {
      inFlight ??= run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
