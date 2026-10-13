import { describe, expect, it } from "vitest";
import { call, harness, linkIn, signIn } from "../support/harness.ts";
import { createOrganizationsAuth } from "./organizations.ts";

describe("add organizations and roles", () => {
  it("creates an organization, invites a member by mail, and lets the member accept", async () => {
    const h = harness();
    const auth = createOrganizationsAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const created = await call(
      auth,
      "POST",
      "/auth/organizations/create",
      { slug: "team", name: "Team" },
      { cookie: ada },
    );
    expect(created.status).toBe(200);
    const { organization, member } = (await created.json()) as {
      organization: { id: string; slug: string };
      member: { role: string };
    };
    expect(member.role).toBe("owner");

    const invite = await call(
      auth,
      "POST",
      "/auth/organizations/invite",
      { organizationId: organization.id, email: "bo@example.com", role: "member" },
      { cookie: ada },
    );
    expect(invite.status).toBe(200);
    const token = linkIn(h, "bo@example.com").searchParams.get("invitation") ?? "";

    const bo = await signIn(auth, h, "bo@example.com");
    const accept = await call(
      auth,
      "POST",
      "/auth/organizations/invitations/accept",
      { token },
      { cookie: bo },
    );
    expect(((await accept.json()) as { member: { role: string } }).member.role).toBe("member");
  });

  it("refuses a reserved slug", async () => {
    const h = harness();
    const auth = createOrganizationsAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const res = await call(
      auth,
      "POST",
      "/auth/organizations/create",
      { slug: "admin", name: "Admin" },
      { cookie: ada },
    );
    expect(await res.json()).toEqual({ error: "slug_reserved" });
  });
});
