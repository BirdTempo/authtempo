import { SELF } from "cloudflare:test";
import { createClient } from "@tempo-auth/client";
import { createHandoff, type HandoffOpener } from "@tempo-auth/handoff";
import { expect, it } from "vitest";

const BASE = "https://example.test";
const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  SELF.fetch(input, init)) as typeof globalThis.fetch;

/** The browser side of the handoff, scripted over the Worker: start, magic link, verify, confirm, press. */
const opener: HandoffOpener = {
  async open(url) {
    const start = await SELF.fetch(url);
    const cont = /data-continue="([^"]+)"/.exec(await start.text())?.[1] ?? "";
    await SELF.fetch(`${BASE}/auth/magic-link/request`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: "ada@example.com", next: cont }),
    });
    const { link } = (await (await SELF.fetch(`${BASE}/__test/last-link`)).json()) as {
      link: string;
    };
    const token = new URL(link).searchParams.get("token") ?? "";
    const verify = await SELF.fetch(`${BASE}/auth/magic-link/verify`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({ token }).toString(),
    });
    const cookie = verify.headers.get("set-cookie")?.split(";")[0] ?? "";
    const h = new URL(`${BASE}${cont}`).searchParams.get("h") ?? "";
    const pressed = await SELF.fetch(`${BASE}/auth/handoff/continue`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, cookie },
      body: new URLSearchParams({ h }).toString(),
    });
    return pressed.headers.get("location");
  },
};

it("signs in through @tempo-auth/handoff and reads the session through @tempo-auth/client on D1", async () => {
  const handoff = createHandoff({ baseURL: BASE, redirect: "example-app://auth", opener, fetch });
  const r = await handoff.signIn();
  expect(r.ok && r.value.user.email).toBe("ada@example.com");
  const token = r.ok ? r.value.token : "";
  const client = createClient({ baseURL: BASE, fetch, credentials: "omit", token: () => token });
  const s = await client.session();
  expect(s.ok && s.value?.user.email).toBe("ada@example.com");
  expect(await client.signOut()).toEqual({ ok: true, value: { ok: true } });
  expect(await client.session()).toEqual({ ok: true, value: null });
});
