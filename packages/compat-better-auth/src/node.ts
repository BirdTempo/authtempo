import { type HandlerLike, type HandlerOptions, handlerOf } from "./next-js.js";

/** The parts of node:http's IncomingMessage and ServerResponse used here, typed by structure (no @types/node). */
export interface NodeRequestLike extends AsyncIterable<Uint8Array> {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}
export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string | string[]): unknown;
  end(body?: Uint8Array): unknown;
}

/**
 * Better Auth's `toNodeHandler(auth)`. The URL's origin comes from the Host
 * and X-Forwarded-Proto headers; core reads only its path. The second
 * argument is authtempo's: the host's `waitUntil` on a serverless Node host.
 */
export function toNodeHandler(
  auth: HandlerLike,
  options?: HandlerOptions,
): (req: NodeRequestLike, res: NodeResponseLike) => Promise<void> {
  const h = handlerOf(auth, options);
  return async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
    }
    const proto = headers.get("x-forwarded-proto") === "https" ? "https" : "http";
    const url = `${proto}://${headers.get("host") ?? "localhost"}${req.url ?? "/"}`;
    const method = req.method ?? "GET";
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const chunks: Uint8Array[] = [];
      for await (const c of req) chunks.push(c);
      body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        body.set(c, at);
        at += c.length;
      }
    }
    const response = await h(new Request(url, { method, headers, ...(body ? { body } : {}) }));
    res.statusCode = response.status;
    response.headers.forEach((v, k) => {
      if (k !== "set-cookie") res.setHeader(k, v);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) res.setHeader("set-cookie", cookies);
    res.end(new Uint8Array(await response.arrayBuffer()));
  };
}
