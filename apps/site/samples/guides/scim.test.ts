import type { Auth, DnsTxtPort } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { API, call, harness, signIn } from "../support/harness.ts";
import { connectDirectory, createScimAuth } from "./scim.ts";

const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** One request of the directory, with its token. */
function scim(auth: Auth, token: string, method: string, path: string, body?: unknown) {
  return auth.handle(
    new Request(`${API}/auth/scim/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/scim+json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

/** An organization of an owner from another domain, with acme.example verified through two test resolvers. */
async function setup() {
  const h = harness();
  const zone = new Map<string, string[]>();
  const dns: DnsTxtPort[] = ["a", "b"].map((name) => ({
    name,
    txt: async (n: string) => zone.get(n) ?? [],
  }));
  const auth = createScimAuth(h, dns);
  const owner = await signIn(auth, h, "owner@owner.example");
  const made = await call(
    auth,
    "POST",
    "/auth/organizations/create",
    { slug: "acme", name: "Acme" },
    { cookie: owner },
  );
  const { organization } = (await made.json()) as { organization: { id: string } };
  const app = { kind: "app", name: "admin-page" } as const;
  const added = await auth.api.sso?.domains.add({
    actor: app,
    organizationId: organization.id,
    domain: "acme.example",
  });
  if (!added?.ok || added.value.record === null) throw new Error("no domain");
  zone.set(added.value.record.name, [added.value.record.value]);
  const verified = await auth.api.sso?.domains.verify({ actor: app, id: added.value.id });
  if (!verified?.ok) throw new Error("not verified");
  return { h, auth, organizationId: organization.id };
}

describe("SCIM provisioning", () => {
  it("creates a person, gives a role by group, refuses another domain, and ends access at a deactivate", async () => {
    const { h, auth, organizationId } = await setup();
    const token = await connectDirectory(auth, organizationId);
    expect(token).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);

    // Okta sends a placeholder password in each create. Core ignores it.
    const created = await scim(auth, token, "POST", "/Users", {
      schemas: [USER],
      userName: "ada@acme.example",
      name: { givenName: "Ada", familyName: "Lovelace" },
      emails: [{ value: "ada@acme.example", primary: true }],
      active: true,
      password: "placeholder",
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("content-type")).toContain("application/scim+json");
    const ada = (await created.json()) as { id: string; password?: unknown };
    expect(ada.password).toBeUndefined();
    const members = () => h.storage.findMany("member", []);
    const adaMember = async () => (await members()).find((m) => m.role !== "owner");
    expect((await adaMember())?.role).toBe("member");

    // The group "Admins" is in the role map, so its member gets the role admin.
    const group = await scim(auth, token, "POST", "/Groups", {
      schemas: [GROUP],
      displayName: "Admins",
      members: [{ value: ada.id }],
    });
    expect(group.status).toBe(201);
    expect((await adaMember())?.role).toBe("admin");
    // With enforce off, Ada can still sign in by her own methods, here a magic link.
    const adaSession = await signIn(auth, h, "ada@acme.example");
    expect(
      (await call(auth, "GET", "/auth/session", undefined, { cookie: adaSession })).status,
    ).toBe(200);

    // An address outside the verified domains creates nothing.
    const outside = await scim(auth, token, "POST", "/Users", {
      schemas: [USER],
      userName: "bob@other.example",
      emails: [{ value: "bob@other.example", primary: true }],
    });
    expect(outside.status).toBe(400);
    expect(((await outside.json()) as { scimType: string }).scimType).toBe("invalidValue");

    // A deactivate removes the member row and ends the person's sessions at once.
    const off = await scim(auth, token, "PATCH", `/Users/${ada.id}`, {
      schemas: [PATCH],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(off.status).toBe(200);
    expect(await adaMember()).toBeUndefined();
    expect(
      (await call(auth, "GET", "/auth/session", undefined, { cookie: adaSession })).status,
    ).toBe(401);
    // The account stays: only the person deletes an account.
    const users = await h.storage.findMany("user", [
      { field: "email", op: "eq", value: "ada@acme.example" },
    ]);
    expect(users).toHaveLength(1);
  });
});
