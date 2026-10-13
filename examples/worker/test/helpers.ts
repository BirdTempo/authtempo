import { SELF } from "cloudflare:test";
import { createClient } from "@tempo-auth/client";

export const BASE = "https://example.test";

/** Reads the last mailed link. The example records only the link, so the token is in it. */
export async function lastLink(): Promise<URL> {
  const { link } = (await (await SELF.fetch(`${BASE}/__test/last-link`)).json()) as {
    link: string;
  };
  return new URL(link);
}

/** A client over SELF.fetch that keeps its own session cookie, as a browser would. */
export function cookieClient() {
  let cookie = "";
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", BASE);
    if (cookie) headers.set("cookie", cookie);
    const res = await SELF.fetch(input as string, { ...init, headers });
    const set = res.headers.get("set-cookie")?.split(";")[0];
    if (set?.includes("=")) cookie = set;
    return res;
  }) as typeof globalThis.fetch;
  return createClient({ baseURL: BASE, fetch });
}

/** Signs in by magic link and answers the client that holds the session cookie. */
export async function signIn(email: string) {
  const client = cookieClient();
  const sent = await client.magicLink.request({ email });
  if (!sent.ok) throw new Error(sent.code);
  const token = (await lastLink()).searchParams.get("token") ?? "";
  const v = await client.magicLink.verify({ token });
  if (!v.ok) throw new Error(v.code);
  return client;
}
