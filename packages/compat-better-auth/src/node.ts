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
  /** node:http's `destroy`: it closes the socket. The handler calls it when a request fails. */
  destroy?(): unknown;
}

/**
 * The body of a Node request as a web stream (M-1 of the plan 12n review).
 * The stream pulls one chunk from node:http at each read of core, and keeps
 * no chunk ahead (a high water mark of 0). So core reads the body at the cap
 * of its route, and a route that answers first pulls no byte. The Fastify
 * binding also gives core a stream with `duplex: "half"`.
 */
function bodyOf(req: NodeRequestLike): ReadableStream<Uint8Array> {
  let chunks: AsyncIterator<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        chunks ??= req[Symbol.asyncIterator]();
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Better Auth's `toNodeHandler(auth)`. The URL's origin comes from the Host
 * and X-Forwarded-Proto headers; core reads only its path. The second
 * argument is authtempo's: the host's `waitUntil` on a serverless Node host.
 * The body goes to core as a stream with `duplex: "half"`. A request that
 * fails, such as one whose client drops the body, closes its socket and
 * throws nothing. node:http catches no rejection of a listener, so one such
 * rejection ended the process (probe of the plan 12n review).
 */
export function toNodeHandler(
  auth: HandlerLike,
  options?: HandlerOptions,
): (req: NodeRequestLike, res: NodeResponseLike) => Promise<void> {
  const h = handlerOf(auth, options);
  return async (req, res) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
      }
      const proto = headers.get("x-forwarded-proto") === "https" ? "https" : "http";
      const url = `${proto}://${headers.get("host") ?? "localhost"}${req.url ?? "/"}`;
      const method = req.method ?? "GET";
      const request =
        method === "GET" || method === "HEAD"
          ? new Request(url, { method, headers })
          : new Request(url, { method, headers, body: bodyOf(req), duplex: "half" } as RequestInit);
      const response = await h(request);
      res.statusCode = response.status;
      response.headers.forEach((v, k) => {
        if (k !== "set-cookie") res.setHeader(k, v);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader("set-cookie", cookies);
      res.end(new Uint8Array(await response.arrayBuffer()));
    } catch {
      res.destroy?.();
    }
  };
}
