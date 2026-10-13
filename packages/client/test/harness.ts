import {
  type AuthConfig,
  createAuth,
  createMemoryAdapter,
  type MailMessage,
} from "@authtempo/core";

export const BASE_URL = "https://api.example.com";
export const APP_ORIGIN = "https://app.example.com";

/** A core instance on the memory adapter, with the mail and the clock a test reads. */
export function makeServer(overrides: Partial<AuthConfig> = {}) {
  let current = new Date("2026-01-01T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const mail: MailMessage[] = [];
  const storage = createMemoryAdapter();
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    clock,
    ...overrides,
  });
  return { auth, storage, mail, clock };
}

/**
 * A fetch that calls `auth.handle` in-process and plays the browser's part:
 * it sets the Origin header, keeps the cookies the API sets, and sends them
 * back. `credentials: "omit"` sends no cookie, as a browser would.
 */
export function inProcessFetch(auth: ReturnType<typeof createAuth>, origin = APP_ORIGIN) {
  const jar = new Map<string, string>();
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set("origin", origin);
    if (req.credentials !== "omit" && jar.size > 0) {
      headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const res = await auth.handle(new Request(req, { headers }));
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const [name, value] = (pair ?? "").split("=");
      if (!name) continue;
      const maxAge = attrs.map((a) => a.trim()).find((a) => a.startsWith("Max-Age="));
      if (maxAge === "Max-Age=0" || !value) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
  return { fetch: fetch as typeof globalThis.fetch, jar };
}

/** The token from a magic link the fake mail port recorded. */
export function tokenFromMail(text: string): string {
  const m = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (!m?.[1]) throw new Error("no token in mail");
  return m[1];
}
