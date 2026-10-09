import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

type Server = ReturnType<typeof makeServer>;

/** A client with its own cookie jar, signed in through the magic link as this address. */
async function signedIn(server: Server, email: string, record?: string[]) {
  const { fetch } = inProcessFetch(server.auth);
  const seen = (input: RequestInfo | URL, init?: RequestInit) => {
    record?.push(`${init?.method ?? "GET"} ${String(input)}`);
    return fetch(input, init);
  };
  const client = createClient({ baseURL: BASE_URL, fetch: seen as typeof fetch });
  const req = await client.magicLink.request({ email });
  if (!req.ok) throw new Error(req.code);
  const v = await client.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
  if (!v.ok) throw new Error(v.code);
  return { client, user: v.value.user };
}

function invitationToken(text: string): string {
  const m = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(text);
  if (!m?.[1]) throw new Error("no invitation token in mail");
  return m[1];
}

describe("organizations through the client", () => {
  it("walks the whole flow from create to delete", async () => {
    const server = makeServer({ organizations: {} });
    const urls: string[] = [];
    const ada = await signedIn(server, "ada@example.com", urls);
    const grace = await signedIn(server, "grace@example.com");
    const lin = await signedIn(server, "lin@example.com");

    const created = await ada.client.organizations.create({ slug: "acme", name: "Acme" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const orgId = created.value.organization.id;
    expect(typeof created.value.organization.createdAt).toBe("string");
    expect(created.value.member.role).toBe("owner");

    const listed = await ada.client.organizations.list();
    expect(listed.ok && listed.value.map((e) => [e.organization.slug, e.role])).toEqual([
      ["acme", "owner"],
    ]);

    const renamed = await ada.client.organizations.update({
      organizationId: orgId,
      name: "Acme 2",
    });
    expect(renamed.ok && renamed.value.name).toBe("Acme 2");

    const added = await ada.client.organizations.members.add({
      organizationId: orgId,
      userId: grace.user.id,
      role: "member",
    });
    expect(added.ok && added.value.email).toBe("grace@example.com");

    const roled = await ada.client.organizations.members.role({
      organizationId: orgId,
      userId: grace.user.id,
      role: "admin",
    });
    expect(roled.ok && roled.value.role).toBe("admin");

    const members = await ada.client.organizations.members.list({ organizationId: orgId });
    expect(members.ok && members.value.map((m) => m.role).sort()).toEqual(["admin", "owner"]);
    expect(
      urls.some((u) => u.startsWith("GET") && u.includes("/organizations/members?organizationId=")),
    ).toBe(true);

    const invited = await ada.client.organizations.invitations.invite({
      organizationId: orgId,
      email: "lin@example.com",
      role: "member",
    });
    expect(invited.ok).toBe(true);
    if (!invited.ok) return;
    expect("token" in invited.value).toBe(false);
    const token = invitationToken(server.mail.at(-1)?.text ?? "");

    const pending = await ada.client.organizations.invitations.list({ organizationId: orgId });
    expect(pending.ok && pending.value.map((i) => i.email)).toEqual(["lin@example.com"]);

    const wrong = await grace.client.organizations.invitations.accept({ token });
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.code).toBe("email_mismatch");

    const accepted = await lin.client.organizations.invitations.accept({ token });
    expect(accepted.ok && accepted.value.organization.id).toBe(orgId);
    expect(accepted.ok && accepted.value.member.role).toBe("member");

    const active = await lin.client.organizations.setActive({ organizationId: orgId });
    expect(active.ok && active.value.session.activeOrganizationId).toBe(orgId);
    const cleared = await lin.client.organizations.setActive({ organizationId: null });
    expect(cleared.ok && cleared.value.session.activeOrganizationId).toBe(null);

    const removed = await ada.client.organizations.members.remove({
      organizationId: orgId,
      userId: grace.user.id,
    });
    expect(removed).toEqual({ ok: true, value: { ok: true } });

    // A second invitation, revoked and declined, covers the other two operations.
    const second = await ada.client.organizations.invitations.invite({
      organizationId: orgId,
      email: "x@example.com",
      role: "member",
    });
    if (!second.ok) throw new Error(second.code);
    const revoked = await ada.client.organizations.invitations.revoke({
      organizationId: orgId,
      invitationId: second.value.id,
    });
    expect(revoked.ok).toBe(true);
    await ada.client.organizations.invitations.invite({
      organizationId: orgId,
      email: "y@example.com",
      role: "member",
    });
    const declined = await ada.client.organizations.invitations.decline({
      token: invitationToken(server.mail.at(-1)?.text ?? ""),
    });
    expect(declined.ok).toBe(true);

    const deleted = await ada.client.organizations.delete({ organizationId: orgId });
    expect(deleted).toEqual({ ok: true, value: { ok: true } });
    const after = await ada.client.organizations.list();
    expect(after.ok && after.value).toEqual([]);
  });

  it("sends no metadata key on create when none is given", async () => {
    const server = makeServer({ organizations: {} });
    const sent: string[] = [];
    const { fetch } = inProcessFetch(server.auth);
    const spy = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") sent.push(init.body);
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    const client = createClient({ baseURL: BASE_URL, fetch: spy });
    await client.magicLink.request({ email: "ada@example.com" });
    await client.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
    await client.organizations.create({ slug: "acme", name: "Acme" });
    const body = JSON.parse(sent.at(-1) ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ slug: "acme", name: "Acme" });
    expect("metadata" in body).toBe(false);
  });

  it("answers not_found when organizations are off", async () => {
    const server = makeServer();
    const { client } = await signedIn(server, "ada@example.com");
    const r = await client.organizations.list();
    expect(!r.ok && r.code).toBe("not_found");
  });
});
