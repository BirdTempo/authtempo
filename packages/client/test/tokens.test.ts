import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

/** A browser client signed in by a magic link, so the user is verified. */
async function signedInBrowser() {
  const server = makeServer();
  const { fetch } = inProcessFetch(server.auth);
  const browser = createClient({ baseURL: BASE_URL, fetch });
  await browser.magicLink.request({ email: "ada@example.com" });
  const verified = await browser.magicLink.verify({
    token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
  });
  if (!verified.ok) throw new Error(verified.code);
  return { fetch, browser };
}

describe("tokens", () => {
  it("creates a token in the browser, uses it from a CLI, and revokes it", async () => {
    const { fetch, browser } = await signedInBrowser();
    const created = await browser.tokens.create({ name: "laptop cli" });
    if (!created.ok) throw new Error(created.code);
    const { token, apiToken } = created.value;
    expect(token).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);
    expect(apiToken).toMatchObject({
      name: "laptop cli",
      hint: token.slice(3, 11),
      lastUsedAt: null,
      organizationId: null,
    });
    expect(typeof apiToken.expiresAt).toBe("string");
    // A CLI keeps no cookie and sends the token as a bearer, as a native app sends its session.
    const cli = createClient({ baseURL: BASE_URL, fetch, credentials: "omit", token: () => token });
    const me = await cli.tokens.current();
    expect(me.ok && me.value.user.email).toBe("ada@example.com");
    expect(me.ok && me.value.apiToken.id).toBe(apiToken.id);
    // A token cannot read or mint tokens: those routes take a session only.
    expect(await cli.tokens.list()).toEqual({ ok: false, code: "unauthorized", status: 401 });
    expect(await cli.tokens.create({ name: "minted" })).toEqual({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    const list = await browser.tokens.list();
    expect(list.ok && list.value.map((t) => t.id)).toEqual([apiToken.id]);
    expect(JSON.stringify(list)).not.toContain(token);
    expect(await browser.tokens.revoke({ id: apiToken.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await cli.tokens.current()).toEqual({ ok: false, code: "unauthorized", status: 401 });
  });

  it("sends no key for an optional field the caller did not set, and null for no expiry", async () => {
    const bodies: string[] = [];
    const client = createClient({
      baseURL: BASE_URL,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(await new Request(input, init).text());
        return Response.json({});
      }) as typeof fetch,
    });
    await client.tokens.create({ name: "a" });
    await client.tokens.create({ name: "b", expiresInDays: null, organizationId: "o1" });
    await client.tokens.create({ name: "c", expiresInDays: 30 });
    expect(bodies).toEqual([
      '{"name":"a"}',
      '{"name":"b","expiresInDays":null,"organizationId":"o1"}',
      '{"name":"c","expiresInDays":30}',
    ]);
  });
});
