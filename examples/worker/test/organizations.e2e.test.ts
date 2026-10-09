import { env, SELF } from "cloudflare:test";
import { createClient } from "@tempo-auth/client";
import { expect, it } from "vitest";

const BASE = "https://example.test";

/** Reads the last mailed link. The example records only the link, so the token is in it. */
async function lastLink(): Promise<URL> {
  const { link } = (await (await SELF.fetch(`${BASE}/__test/last-link`)).json()) as {
    link: string;
  };
  return new URL(link);
}

/** A client over SELF.fetch that keeps its own session cookie, as a browser would. */
function cookieClient() {
  let cookie = "";
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", BASE);
    if (cookie) headers.set("cookie", cookie);
    const res = await SELF.fetch(input as string, { ...init, headers });
    const set = res.headers.get("set-cookie")?.split(";")[0];
    if (set?.includes("=")) cookie = set;
    return res;
  }) as typeof globalThis.fetch;
  return createClient({ baseURL: BASE, fetch });
}

async function signIn(email: string) {
  const client = cookieClient();
  const sent = await client.magicLink.request({ email });
  if (!sent.ok) throw new Error(sent.code);
  const token = (await lastLink()).searchParams.get("token") ?? "";
  const v = await client.magicLink.verify({ token });
  if (!v.ok) throw new Error(v.code);
  return client;
}

it("creates, invites, and accepts an organization on D1", async () => {
  const ada = await signIn("ada@example.com");
  const grace = await signIn("grace@example.com");

  const created = await ada.organizations.create({ slug: "acme", name: "Acme" });
  if (!created.ok) throw new Error(created.code);

  const invited = await ada.organizations.invitations.invite({
    organizationId: created.value.organization.id,
    email: "grace@example.com",
    role: "member",
  });
  expect(invited.ok).toBe(true);
  const token = (await lastLink()).searchParams.get("invitation") ?? "";
  expect(token).toMatch(/^inv_/);

  const accepted = await grace.organizations.invitations.accept({ token });
  expect(accepted.ok).toBe(true);

  const listed = await grace.organizations.list();
  expect(listed.ok && listed.value.map((e) => [e.organization.slug, e.role])).toEqual([
    ["acme", "member"],
  ]);

  const rows = await env.DB.prepare("SELECT accepted_at FROM ta_invitation").all<{
    accepted_at: number | null;
  }>();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0]?.accepted_at).not.toBeNull();
});
