import { type ClientCode, createClient } from "@tempo-auth/client";
import type { PublicSession } from "@tempo-auth/core";
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
  basePath?: string;
  /** `<scheme>auth` for a production app, or the loopback URL the API's `devRedirectPattern` admits. */
  redirect: string;
  opener: HandoffOpener;
  fetch?: typeof fetch;
  crypto?: HandoffCrypto;
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
  const client = createClient({
    baseURL: options.baseURL,
    basePath,
    credentials: "omit",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const startUrl = (challenge: string) =>
    `${options.baseURL}${basePath}/handoff/start?challenge=${encode(challenge)}&redirect=${encode(options.redirect)}`;
  return {
    startUrl,
    async signIn() {
      const { verifier, challenge } = await makePkce(c);
      const returned = await options.opener.open(startUrl(challenge), options.redirect);
      if (returned === null) return { ok: false, code: "cancelled", status: 0 };
      const parsed = parseReturnedUrl(options.redirect, returned);
      if (!parsed.ok) return { ok: false, code: "redirect_mismatch", status: 0 };
      const code = parsed.params.code;
      if (!code) return { ok: false, code: "unexpected", status: 0 };
      return client.handoff.redeem({ code, verifier });
    },
  };
}
