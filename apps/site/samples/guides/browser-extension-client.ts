import { type Client, createClient } from "@authtempo/client";

/** Where the extension keeps the token. In an extension: chrome.storage.local. */
export interface TokenBox {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** The client of the extension, in token mode: the bearer, and no cookie. */
export function createExtensionClient(box: TokenBox, fetch?: typeof globalThis.fetch): Client {
  return createClient({
    baseURL: "https://api.example.com",
    credentials: "omit",
    token: () => box.get(),
    // The server ended the session: the token is dead. Clear it only when the box still
    // holds the token that ended, because a newer sign-in may have written another one.
    onSessionEnd: async (sent) => {
      if ((await box.get()) === sent) await box.clear();
    },
    ...(fetch ? { fetch } : {}),
  });
}

/** The sign-in by email code. `askCode` shows a field in the popup and answers what the person types. */
export async function signInByCode(
  client: Client,
  box: TokenBox,
  email: string,
  askCode: () => Promise<string>,
) {
  const sent = await client.emailOtp.request({ email });
  if (!sent.ok) return sent;
  const r = await client.emailOtp.verify({ email, code: await askCode() });
  // A person with the second factor on gets a challenge, not a token.
  if (r.ok && "token" in r.value) {
    await box.set(r.value.token);
    // The verify read the session before the box held the token: read it again for the popup.
    client.store.refetchIfStarted();
  }
  return r;
}

/** The sign-out. It clears the box when the server ended the session or did not know it. */
export async function signOut(client: Client, box: TokenBox) {
  const r = await client.signOut();
  // A network failure keeps the token, so the person can sign out again.
  if (r.ok || r.code === "unauthorized") await box.clear();
  return r;
}
