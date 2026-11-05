import {
  type Auth,
  createMemoryAdapter,
  createMemoryLimiter,
  type LimiterPort,
  type MailMessage,
  type MailPort,
  type StorageAdapter,
  systemClock,
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

/**
 * A memory limiter that says it is shared, for the construct check. It is a
 * test of one process: the counts stay in this isolate. Never use it in an app.
 */
export function sharedTestLimiter(): LimiterPort {
  const memory = createMemoryLimiter(systemClock);
  return { allow: (key, window) => memory.allow(key, window), scope: "shared" };
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
  method: "GET" | "POST" | "OPTIONS",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return auth.handle(request(method, path, body, headers));
}

/**
 * `call` with a `waitUntil` that the call waits for, as a host keeps that
 * work alive. The work after the answer, such as the uniform sign-up mail,
 * has then run. The flush of the observer runs under it too.
 */
export async function callSettled(
  auth: Auth,
  method: "GET" | "POST" | "OPTIONS",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const after: Promise<unknown>[] = [];
  const res = await auth.handle(request(method, path, body, headers), {
    waitUntil: (work) => void after.push(work),
  });
  await Promise.all(after);
  return res;
}

function request(method: string, path: string, body: unknown, headers: Record<string, string>) {
  return new Request(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** The `__Host-tempo_session=…` pair that a response sets, or "" when it sets none. */
export function sessionCookieOf(res: Response): string {
  const c = res.headers.getSetCookie().find((x) => x.startsWith("__Host-tempo_session="));
  return c?.split(";")[0] ?? "";
}

/**
 * The `__Host-tempo_signup=…` pair that a sign-up answer sets: the sign-up
 * proof of the browser. A confirm that sends it keeps the password.
 */
export function proofCookieOf(res: Response): string {
  const c = res.headers.getSetCookie().find((x) => x.startsWith("__Host-tempo_signup="));
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
