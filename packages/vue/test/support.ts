import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";

export const API = "https://api.example.com";
export const APP = "https://app.example.com";
/** The default session cookie of core (plan 12b). */
export const SESSION = "__Host-tempo_session";

/** A core instance on the memory adapter that keeps its mails. */
export function makeServer(options: { clock?: { now(): Date }; basePath?: string } = {}): {
  auth: Auth;
  mail: MailMessage[];
} {
  const mail: MailMessage[] = [];
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.basePath ? { basePath: options.basePath } : {}),
  });
  return { auth, mail };
}

/** A browser's fetch to core in process: the page's Origin and one cookie jar. */
export function browserFetch(auth: Auth): typeof fetch {
  const jar = new Map<string, string>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set("origin", APP);
    if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await auth.handle(new Request(req, { headers }));
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const [name = "", value = ""] = pair.split("=");
      if (attrs.some((a) => a.trim() === "Max-Age=0") || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  }) as typeof fetch;
}

/** The token of the last magic link mail. */
export function linkToken(mail: MailMessage[]): string {
  return /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
}
