import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import {
  browserPendingStore,
  createOAuthClient,
  PENDING_TTL_MS,
  registerOAuthClient,
} from "../src/oauth/index.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const ISSUER = `${BASE_URL}/auth`;
const RESOURCE = `${BASE_URL}/mcp`;
const SPA = "https://spa.example.org";

/** A Storage in memory, the shape of sessionStorage. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    keys: () => [...m.keys()],
  };
}

describe("the OAuth client in a browser on its own origin (plan 11d, Task 3)", () => {
  it("finishes PKCE with a safelisted request that the browser may read, and keeps the pending sign-in in sessionStorage", async () => {
    const server = makeServer({ oauth: { resources: [RESOURCE], registration: { cimd: false } } });
    const person = inProcessFetch(server.auth);
    const c = createClient({ baseURL: BASE_URL, fetch: person.fetch });
    await c.magicLink.request({ email: "ada@example.com" });
    await c.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
    const serverFetch = (async (i: RequestInfo | URL, init?: RequestInit) =>
      server.auth.handle(new Request(i, init))) as typeof fetch;
    const reg = await registerOAuthClient({
      issuer: ISSUER,
      clientName: "SPA",
      redirectUris: [`${SPA}/callback`],
      fetch: serverFetch,
    });
    if (!reg.ok) throw new Error(reg.code);

    // The page's fetch: the browser adds the page's Origin, and keeps the request's headers.
    const sent: { req: Request; init: RequestInit | undefined }[] = [];
    const answers: Response[] = [];
    const pageFetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(i, init);
      // The init keeps `credentials`; a server-side Request may not keep the field.
      sent.push({ req: req.clone(), init });
      const headers = new Headers(req.headers);
      headers.set("origin", SPA);
      const res = await server.auth.handle(new Request(req, { headers }));
      answers.push(res.clone());
      return res;
    }) as typeof fetch;
    const storage = memoryStorage();
    const oauth = createOAuthClient({
      issuer: ISSUER,
      clientId: reg.value.clientId,
      redirectUri: `${SPA}/callback`,
      resource: RESOURCE,
      scopes: ["openid"],
      fetch: pageFetch,
      pending: browserPendingStore(storage),
    });
    const url = await oauth.authorizeURL();
    if (!url.ok) throw new Error(url.code);
    expect(storage.keys()).toHaveLength(1);
    const page = await person.fetch(url.value);
    const id = /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
    const cookie = [...person.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const allowed = await server.auth.handle(
      new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL, cookie },
        body: new URLSearchParams({ request_id: id ?? "", decision: "allow" }).toString(),
      }),
    );
    const tokens = await oauth.handleRedirect(allowed.headers.get("location") ?? "");
    if (!tokens.ok) throw new Error(tokens.code);
    expect(storage.keys()).toHaveLength(0);

    const token = sent.find((s) => new URL(s.req.url).pathname === "/auth/oauth/token");
    if (!token) throw new Error("no token request");
    // A CORS-safelisted request: no preflight in a browser.
    expect([...token.req.headers.keys()].sort()).toEqual(["accept", "content-type"]);
    expect(token.req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(token.init?.credentials).toBe("omit");
    const answer = answers.at(-1);
    expect(answer?.headers.get("access-control-allow-origin")).toBe(SPA);
    expect(answer?.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("removes the abandoned sign-ins older than 10 minutes from sessionStorage at each start", async () => {
    const storage = memoryStorage();
    storage.setItem("other-app:key", "kept");
    const store = browserPendingStore(storage);
    const base = { issuer: ISSUER, clientId: "cl_a", verifier: "v" };
    await store.put({ ...base, state: "old", createdAt: 0 });
    await store.put({ ...base, state: "young", createdAt: PENDING_TTL_MS });
    await store.put({ ...base, state: "new", createdAt: PENDING_TTL_MS + 1 });
    expect(storage.keys().sort()).toEqual([
      "authtempo-oauth:new",
      "authtempo-oauth:young",
      "other-app:key",
    ]);
  });
});
