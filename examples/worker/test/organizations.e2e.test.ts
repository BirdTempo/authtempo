import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { BASE, lastLink, signIn } from "./helpers.js";

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
  const link = await lastLink();
  // The example sets no appURL, so the link opens on the base URL (Review M-12).
  expect(link.origin).toBe(BASE);
  const token = link.searchParams.get("invitation") ?? "";
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
