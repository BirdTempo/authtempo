import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

describe("magic link", () => {
  it("requests a link, verifies it as JSON, and holds the cookie afterwards", async () => {
    const server = makeServer();
    const { fetch, jar } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    expect(await client.magicLink.request({ email: "ada@example.com", next: "/inbox" })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const token = tokenFromMail(server.mail[0]?.text ?? "");
    const v = await client.magicLink.verify({ token });
    expect(v.ok && v.value.user.email).toBe("ada@example.com");
    expect(jar.size).toBe(1);
    // A second verify of the same token is a replay.
    expect(await client.magicLink.verify({ token })).toMatchObject({
      ok: false,
      code: "invalid_token",
      status: 400,
    });
  });

  it("passes rate_limited through with its status", async () => {
    const server = makeServer();
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    let last: Awaited<ReturnType<typeof client.magicLink.request>> | null = null;
    for (let i = 0; i < 6; i++) last = await client.magicLink.request({ email: "ada@example.com" });
    expect(last).toEqual({ ok: false, code: "rate_limited", status: 429 });
  });

  it("redeems a handoff code as a bearer answer", async () => {
    // The redeem's own behavior is proved in the handoff package; here the client's call shape.
    const calls: Request[] = [];
    const client = createClient({
      baseURL: BASE_URL,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Request(input, init));
        return Response.json({
          token: "ts_x",
          user: { id: "u1", email: "a@b.c" },
          session: { id: "s1" },
        });
      }) as typeof fetch,
    });
    const r = await client.handoff.redeem({ code: "hc_abc", verifier: "v".repeat(43) });
    expect(r.ok && r.value.token).toBe("ts_x");
    expect(calls[0]?.url).toBe(`${BASE_URL}/auth/handoff/redeem`);
    expect(await calls[0]?.text()).toBe(`{"code":"hc_abc","verifier":"${"v".repeat(43)}"}`);
  });
});
