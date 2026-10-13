import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

describe("jwt (plan 9g)", () => {
  it("answers a JWT for the signed-in browser, and unauthorized with no session", async () => {
    const server = makeServer();
    const { fetch } = inProcessFetch(server.auth);
    const browser = createClient({ baseURL: BASE_URL, fetch });
    await browser.magicLink.request({ email: "ada@example.com" });
    const verified = await browser.magicLink.verify({
      token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
    });
    if (!verified.ok) throw new Error(verified.code);
    const r = await browser.jwt.token();
    if (!r.ok) throw new Error(r.code);
    expect(r.value.token.split(".")).toHaveLength(3);
    expect((await server.auth.api.jwt?.verify(r.value.token))?.email).toBe("ada@example.com");
    const anonymous = createClient({ baseURL: BASE_URL, fetch, credentials: "omit" });
    expect(await anonymous.jwt.token()).toEqual({ ok: false, code: "unauthorized", status: 401 });
  });
});
