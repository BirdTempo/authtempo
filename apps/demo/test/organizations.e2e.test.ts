import { describe, expect, it } from "vitest";
import { call, lastLink, newSandbox, sameSandbox, signInByLink, whoami } from "./helpers.js";

describe("organizations", () => {
  it("creates an organization, invites a second address, accepts from the mailbox, and changes the role", async () => {
    const ada = await newSandbox();
    await signInByLink(ada, "ada@example.com");
    const created = await call(ada, "POST", "/auth/organizations/create", {
      slug: "acme",
      name: "Acme",
    });
    expect(created.status).toBe(200);
    const { organization } = (await created.json()) as { organization: { id: string } };

    const invited = await call(ada, "POST", "/auth/organizations/invite", {
      organizationId: organization.id,
      email: "grace@example.com",
      role: "member",
    });
    expect(invited.status).toBe(200);

    // Grace is a second visitor of the same sandbox; her mail is in its mailbox.
    const grace = sameSandbox(ada);
    const link = await lastLink(grace, "grace@example.com");
    const token = link.searchParams.get("invitation") ?? "";
    expect(token).toMatch(/^inv_/);
    await signInByLink(grace, "grace@example.com");
    const accepted = await call(grace, "POST", "/auth/organizations/invitations/accept", { token });
    expect(accepted.status).toBe(200);
    const graceId = (await whoami(grace))?.id ?? "";

    const role = await call(ada, "POST", "/auth/organizations/members/role", {
      organizationId: organization.id,
      userId: graceId,
      role: "admin",
    });
    expect(role.status).toBe(200);
    const listed = await call(grace, "GET", "/auth/organizations");
    const body = (await listed.json()) as {
      organizations: { organization: { slug: string }; role: string }[];
    };
    expect(body.organizations.map((e) => [e.organization.slug, e.role])).toEqual([
      ["acme", "admin"],
    ]);
  });
});
