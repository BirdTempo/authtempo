import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CLIENT_IP_HEADER, type Serve } from "./app.ts";

/** A fetch Request from a Node request. The body is text: core reads JSON and forms only. */
async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === CLIENT_IP_HEADER) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const ip = req.socket.remoteAddress;
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  const method = req.method ?? "GET";
  const chunks: Buffer[] = [];
  if (method !== "GET" && method !== "HEAD")
    for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null;
  return new Request(new URL(req.url ?? "/", origin), { method, headers, body });
}

/** Writes a fetch Response to a Node response. Each Set-Cookie stays its own header line. */
async function send(res: ServerResponse, answer: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  answer.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(answer.status, headers);
  res.end(Buffer.from(await answer.arrayBuffer()));
}

export const serveNode: Serve = (handler, options) => {
  const server = createServer((req, res) => {
    toRequest(req, options.origin)
      .then(handler)
      .then((answer) => send(res, answer))
      .catch(() => {
        res.writeHead(500).end();
      });
  });
  return new Promise((resolve) => {
    server.listen(options.port, options.hostname, () =>
      resolve({ close: () => new Promise<void>((done) => server.close(() => done())) }),
    );
  });
};
