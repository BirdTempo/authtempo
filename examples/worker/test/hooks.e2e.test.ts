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

it("runs organization hooks on D1: a refusal leaves no row, an after hook writes its row in the same database, and an after hook that throws keeps the organization", async () => {
  const ada = await signIn("hooks-ada@example.com");

  const created = await ada.organizations.create({ slug: "tenant-co", name: "Tenant Co" });
  if (!created.ok) throw new Error(created.code);
  expect(
    await env.DB.prepare("SELECT owner_id, name FROM app_tenant WHERE organization_id = ?")
      .bind(created.value.organization.id)
      .first(),
  ).toEqual({ owner_id: created.value.member.userId, name: "Tenant Co" });

  const refused = await ada.organizations.create({ slug: "refused-co", name: "Refused Co" });
  expect(refused).toEqual({
    ok: false,
    code: "hook_refused",
    status: 403,
    message: "This name is not open for sign-up.",
  });
  expect(
    await env.DB.prepare("SELECT id FROM ta_organization WHERE slug = ?")
      .bind("refused-co")
      .first(),
  ).toBeNull();

  // The after hook throws: the organization and its owner row stay.
  const failing = await ada.organizations.create({ slug: "after-fails-co", name: "After Fails" });
  if (!failing.ok) throw new Error(failing.code);
  expect(
    await env.DB.prepare("SELECT role FROM ta_member WHERE organization_id = ?")
      .bind(failing.value.organization.id)
      .first(),
  ).toEqual({ role: "owner" });
  expect(
    await env.DB.prepare("SELECT organization_id FROM app_tenant WHERE organization_id = ?")
      .bind(failing.value.organization.id)
      .first(),
  ).toBeNull();
});
