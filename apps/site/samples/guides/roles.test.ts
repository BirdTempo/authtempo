import { describe, expect, it } from "vitest";
import { API, call, harness, signIn } from "../support/harness.ts";
import { createRolesAuth, writeProject } from "./roles.ts";

describe("roles and permissions", () => {
  it("a dynamic role narrows at the next request", async () => {
    const h = harness();
    const auth = createRolesAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const bo = await signIn(auth, h, "bo@example.com");
    const boUser = (
      (await (await call(auth, "GET", "/auth/session", undefined, { cookie: bo })).json()) as {
        user: { id: string };
      }
    ).user;
    const created = await call(
      auth,
      "POST",
      "/auth/organizations/create",
      { slug: "acme", name: "Acme" },
      { cookie: ada },
    );
    const { organization } = (await created.json()) as { organization: { id: string } };
    const organizationId = organization.id;

    // The owner stores the role "editor" for this organization only, and gives it to Bo.
    const role = await call(
      auth,
      "POST",
      "/auth/organizations/roles/create",
      { organizationId, name: "editor", rank: 1, permissions: { project: ["read", "write"] } },
      { cookie: ada },
    );
    expect(role.status).toBe(200);
    const added = await call(
      auth,
      "POST",
      "/auth/organizations/members/add",
      { organizationId, userId: boUser.id, role: "editor" },
      { cookie: ada },
    );
    expect(added.status).toBe(200);

    const write = () =>
      writeProject(
        auth,
        new Request(`${API}/projects`, { headers: { cookie: bo } }),
        organizationId,
      );
    expect((await write()).status).toBe(200);

    // The owner takes "write" from the role. Bo's next request has no write.
    const narrowed = await call(
      auth,
      "POST",
      "/auth/organizations/roles/update",
      { organizationId, name: "editor", permissions: { project: ["read"] } },
      { cookie: ada },
    );
    expect(narrowed.status).toBe(200);
    expect((await write()).status).toBe(403);

    // The client check reads the same rule, and only hides a control.
    const check = await call(
      auth,
      "POST",
      "/auth/organizations/has-permission",
      { organizationId, permissions: { project: ["read"] } },
      { cookie: bo },
    );
    expect(await check.json()).toEqual({ success: true });
  });
});
