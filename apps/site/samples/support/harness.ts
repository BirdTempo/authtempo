import {
  type Auth,
  createMemoryAdapter,
  type MailMessage,
  type MailPort,
  type StorageAdapter,
} from "@authtempo/core";

// The test side of the samples. No page includes this file.
export const API = "https://api.example.com";
export const APP = "https://app.example.com";
export const SECRET = "0123456789abcdef0123456789abcdef";

/** What a sample app takes from its host. A sample's `create…Auth` takes this shape. */
export interface SampleDeps {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}

export interface Harness extends SampleDeps {
  sent: MailMessage[];
}

/** A memory database and a mail port that keeps every mail. The memory adapter is for tests only. */
export function harness(): Harness {
  const sent: MailMessage[] = [];
  return {
    storage: createMemoryAdapter(),
    mail: {
      async send(m) {
        sent.push(m);
      },
    },
    secret: SECRET,
    sent,
  };
}

export function lastMailTo(h: Harness, to: string): MailMessage {
  const m = h.sent.filter((x) => x.to === to).at(-1);
  if (!m) throw new Error(`no mail to ${to}`);
  return m;
}

/** The first link of the last mail to an address. */
export function linkIn(h: Harness, to: string): URL {
  const m = /https?:\/\/\S+/.exec(lastMailTo(h, to).text);
  if (!m) throw new Error(`no link in the last mail to ${to}`);
  return new URL(m[0]);
}

/** The code of 6 or 8 digits in the last mail to an address. */
export function codeIn(h: Harness, to: string): string {
  const m = /\b(\d{8}|\d{6})\b/.exec(lastMailTo(h, to).text);
  if (!m?.[1]) throw new Error(`no code in the last mail to ${to}`);
  return m[1];
}

/** One request to `auth.handle`, with a JSON body when one is given. No Origin header: a server caller. */
export function call(
  auth: Auth,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return auth.handle(
    new Request(`${API}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

/** The `tempo_session=…` pair that a response sets, or "" when it sets none. */
export function sessionCookieOf(res: Response): string {
  const c = res.headers.getSetCookie().find((x) => x.startsWith("tempo_session="));
  return c?.split(";")[0] ?? "";
}

/** Signs a person in by magic link, and answers the session cookie pair. */
export async function signIn(auth: Auth, h: Harness, email: string): Promise<string> {
  await call(auth, "POST", "/auth/magic-link/request", { email });
  const token = linkIn(h, email).searchParams.get("token") ?? "";
  const res = await call(auth, "POST", "/auth/magic-link/verify", { token });
  if (res.status !== 200) throw new Error(`the magic link verify answered ${res.status}`);
  return sessionCookieOf(res);
}
