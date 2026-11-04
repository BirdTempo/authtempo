import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrganizationLimits } from "../src/config.js";
import {
  hookRefusal,
  ORGANIZATION_HOOK_POINTS,
  type OrganizationHooks,
} from "../src/engine/hooks.js";
import {
  addMember,
  createOrganization,
  deleteOrganization,
  removeMember,
  updateOrganization,
} from "../src/engine/organizations.js";
import { createSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { organizationRoutes } from "../src/http/routes/organizations.js";
import type { UserRow } from "../src/schema.js";
import { makeAuth, post } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Every organization hook point records its name and its event, in call
 * order. `over` replaces some points with hooks that do not record.
 */
function recorded(over: OrganizationHooks = {}, limits: OrganizationLimits = {}) {
  const calls: [string, unknown][] = [];
  const organization = Object.fromEntries(
    Object.keys(ORGANIZATION_HOOK_POINTS).map((name) => [
      name,
      (e: unknown) => {
        calls.push([name, e]);
      },
    ]),
  ) as OrganizationHooks;
  const auth = makeAuth({
    organizations: { limits },
    hooks: { organization: { ...organization, ...over } },
  });
  return { auth, calls, names: () => calls.map(([name]) => name) };
}

async function routeCreate(auth: ReturnType<typeof makeAuth>, user: UserRow, slug: string) {
  const handle = createRouter(auth.config, organizationRoutes(auth.config));
  const { token } = await createSession(auth.config, {
    userId: user.id,
    ip: null,
    userAgent: null,
    proved: true,
  });
  return handle(
    post(
      "/auth/organizations/create",
      { slug, name: "Acme" },
      { authorization: `Bearer ${token}` },
    ),
  );
}

describe("organization create hooks (plan 9d)", () => {
  it("fires beforeCreate, beforeAddMember, afterAddMember, and afterCreate once each, in this order, with the stated events", async () => {
    const { auth, calls, names } = recorded();
    const ada = await auth.seedUser("ada@example.com");
    const r = await createOrganization(auth.config, { user: ada, slug: "acme", name: "Acme" });
    if (!r.ok) throw new Error(r.code);
    const { organization, member } = r.value;
    expect(names()).toEqual(["beforeCreate", "beforeAddMember", "afterAddMember", "afterCreate"]);
    expect(calls[0]?.[1]).toEqual({ organization, user: ada });
    expect(calls[1]?.[1]).toEqual({
      organization,
      member: { userId: ada.id, role: "owner" },
      memberUser: ada,
      by: ada,
      via: "create",
      invitation: null,
    });
    expect(calls[2]?.[1]).toEqual({
      organization,
      member,
      memberUser: ada,
      by: ada,
      via: "create",
      invitation: null,
    });
    expect(calls[3]?.[1]).toEqual({ organization, member, user: ada });
  });

  it("runs the before hooks before the write, with the id that core then writes", async () => {
    const seen: unknown[] = [];
    const { auth } = recorded({
      async beforeCreate(e) {
        seen.push(
          await auth.storage.findOne("organization", [
            { field: "id", op: "eq", value: e.organization.id },
          ]),
        );
      },
    });
    const ada = await auth.seedUser("ada@example.com");
    const r = await createOrganization(auth.config, { user: ada, slug: "acme", name: "Acme" });
    if (!r.ok) throw new Error(r.code);
    expect(seen).toEqual([null]);
    expect(
      await auth.storage.findOne("organization", [
        { field: "id", op: "eq", value: r.value.organization.id },
      ]),
    ).not.toBeNull();
  });

  it("leaves no row and answers 500 hook_failed with no message or stack when beforeCreate throws a plain Error (Review Focus 1)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { auth } = recorded({
      beforeCreate() {
        throw new Error("tenant store down at db-7");
      },
    });
    const ada = await auth.seedUser("ada@example.com");
    const res = await routeCreate(auth, ada, "acme");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(`{"error":"hook_failed"}`);
    expect(await auth.storage.findMany("organization", [])).toEqual([]);
    expect(await auth.storage.findMany("member", [])).toEqual([]);
    expect(log.mock.calls).toEqual([
      ["authtempo: before hook failed", "organization.beforeCreate", "Error"],
    ]);
  });

  it("answers 403 hook_refused with the hook's message and leaves no row", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { auth } = recorded({
      beforeCreate() {
        throw hookRefusal("Choose another name.");
      },
    });
    const ada = await auth.seedUser("ada@example.com");
    const res = await routeCreate(auth, ada, "acme");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "hook_refused", message: "Choose another name." });
    expect(await auth.storage.findMany("organization", [])).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps the organization and its owner row, logs one line, and answers the organization when afterCreate throws (Review Focus 2)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { auth } = recorded({
      afterCreate() {
        throw new Error("tenant store down");
      },
    });
    const ada = await auth.seedUser("ada@example.com");
    const res = await routeCreate(auth, ada, "acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organization: { id: string; slug: string } };
    expect(body.organization.slug).toBe("acme");
    expect((await auth.storage.findMany("organization", [])).map((o) => o.id)).toEqual([
      body.organization.id,
    ]);
    expect((await auth.storage.findMany("member", [])).map((m) => [m.userId, m.role])).toEqual([
      [ada.id, "owner"],
    ]);
    expect(log.mock.calls).toEqual([
      ["authtempo: after hook failed", "organization.afterCreate", body.organization.id, "Error"],
    ]);
  });

  it("gives each hook a copy: a change to the event changes no row and no answer", async () => {
    const { auth } = recorded({
      beforeCreate(e) {
        e.organization.name = "Changed";
        if (e.organization.metadata) e.organization.metadata.plan = "pro";
      },
    });
    const ada = await auth.seedUser("ada@example.com");
    const r = await createOrganization(auth.config, {
      user: ada,
      slug: "acme",
      name: "Acme",
      metadata: { plan: "free" },
    });
    expect(r.ok && r.value.organization).toMatchObject({
      name: "Acme",
      metadata: { plan: "free" },
    });
    expect(
      await auth.storage.findOne("organization", [{ field: "slug", op: "eq", value: "acme" }]),
    ).toMatchObject({ name: "Acme", metadata: { plan: "free" } });
  });

  it("runs no hook for a slug that is taken", async () => {
    const { auth, calls, names } = recorded();
    const ada = await auth.seedUser("ada@example.com");
    const grace = await auth.seedUser("grace@example.com");
    expect((await createOrganization(auth.config, { user: ada, slug: "acme", name: "A" })).ok).toBe(
      true,
    );
    calls.length = 0;
    expect(
      await createOrganization(auth.config, { user: grace, slug: "acme", name: "B" }),
    ).toMatchObject({ ok: false, code: "slug_taken" });
    expect(names()).toEqual([]);
  });

  it("perUser counts the user's member rows at any rank, refuses at the limit with no hook call, and a leave frees a slot (Review Focus 4)", async () => {
    const { auth, calls, names } = recorded({}, { perUser: 2 });
    const ada = await auth.seedUser("ada@example.com");
    const grace = await auth.seedUser("grace@example.com");
    const own = await createOrganization(auth.config, { user: ada, slug: "ada-co", name: "Ada" });
    const other = await createOrganization(auth.config, {
      user: grace,
      slug: "grace-co",
      name: "Grace",
    });
    if (!own.ok || !other.ok) throw new Error("setup");
    const graceCo = other.value.organization.id;
    // A viewer row counts as much as an owner row: Ada created one organization and is in two.
    const added = await addMember(auth.config, {
      user: grace,
      organizationId: graceCo,
      userId: ada.id,
      role: "viewer",
    });
    expect(added.ok).toBe(true);
    calls.length = 0;
    expect(await createOrganization(auth.config, { user: ada, slug: "third", name: "T" })).toEqual({
      ok: false,
      code: "organization_limit",
      status: 409,
    });
    expect(names()).toEqual([]);
    expect(
      await auth.storage.findOne("organization", [{ field: "slug", op: "eq", value: "third" }]),
    ).toBeNull();
    const left = await removeMember(auth.config, {
      user: ada,
      organizationId: graceCo,
      userId: ada.id,
    });
    expect(left.ok).toBe(true);
    expect(
      (await createOrganization(auth.config, { user: ada, slug: "third", name: "T" })).ok,
    ).toBe(true);
  });
});

describe("organization update and delete hooks (plan 9d)", () => {
  it("fires beforeUpdate with the patch and the caller's member row, then afterUpdate with the stored row", async () => {
    const { auth, calls, names } = recorded();
    const ada = await auth.seedUser("ada@example.com");
    const c = await createOrganization(auth.config, { user: ada, slug: "acme", name: "Acme" });
    if (!c.ok) throw new Error(c.code);
    calls.length = 0;
    const r = await updateOrganization(auth.config, {
      user: ada,
      organizationId: c.value.organization.id,
      name: "Acme Two",
      slug: "acme-two",
    });
    if (!r.ok) throw new Error(r.code);
    expect(names()).toEqual(["beforeUpdate", "afterUpdate"]);
    expect(calls[0]?.[1]).toEqual({
      organization: c.value.organization,
      patch: { name: "Acme Two", slug: "acme-two" },
      member: c.value.member,
      user: ada,
    });
    expect(calls[1]?.[1]).toEqual({ organization: r.value, member: c.value.member, user: ada });
    expect(r.value).toMatchObject({ name: "Acme Two", slug: "acme-two" });
  });

  it("keeps the old row when beforeUpdate refuses", async () => {
    const { auth } = recorded({
      beforeUpdate() {
        throw hookRefusal("Names are fixed.");
      },
    });
    const ada = await auth.seedUser("ada@example.com");
    const c = await createOrganization(auth.config, { user: ada, slug: "acme", name: "Acme" });
    if (!c.ok) throw new Error(c.code);
    expect(
      await updateOrganization(auth.config, {
        user: ada,
        organizationId: c.value.organization.id,
        name: "Other",
      }),
    ).toEqual({ ok: false, code: "hook_refused", status: 403, message: "Names are fixed." });
    expect(
      await auth.storage.findOne("organization", [
        { field: "id", op: "eq", value: c.value.organization.id },
      ]),
    ).toMatchObject({ name: "Acme" });
  });

  it("fires beforeDelete and afterDelete, and a refusal keeps the organization and its members", async () => {
    const { auth, calls, names } = recorded();
    const ada = await auth.seedUser("ada@example.com");
    const c = await createOrganization(auth.config, { user: ada, slug: "acme", name: "Acme" });
    if (!c.ok) throw new Error(c.code);
    calls.length = 0;
    const id = c.value.organization.id;
    expect(await deleteOrganization(auth.config, { user: ada, organizationId: id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(names()).toEqual(["beforeDelete", "afterDelete"]);
    expect(calls.map(([, e]) => e)).toEqual([
      { organization: c.value.organization, user: ada },
      { organization: c.value.organization, user: ada },
    ]);

    const refusing = recorded({
      beforeDelete() {
        throw hookRefusal("Export your data first.");
      },
    });
    const grace = await refusing.auth.seedUser("grace@example.com");
    const g = await createOrganization(refusing.auth.config, {
      user: grace,
      slug: "grace-co",
      name: "Grace",
    });
    if (!g.ok) throw new Error(g.code);
    expect(
      await deleteOrganization(refusing.auth.config, {
        user: grace,
        organizationId: g.value.organization.id,
      }),
    ).toMatchObject({ ok: false, code: "hook_refused", message: "Export your data first." });
    expect(await refusing.auth.storage.findMany("organization", [])).toHaveLength(1);
    expect(await refusing.auth.storage.findMany("member", [])).toHaveLength(1);
    // The refusal undoes the delete, so no after hook reports it (parked Minor 6).
    expect(refusing.names()).not.toContain("afterDelete");
  });

  it("runs beforeUpdate and beforeDelete before the first write (parked Minor 5)", async () => {
    const seen: unknown[] = [];
    const { auth } = recorded({
      async beforeUpdate(e) {
        seen.push(
          await auth.storage.findOne("organization", [
            { field: "id", op: "eq", value: e.organization.id },
          ]),
        );
      },
      async beforeDelete(e) {
        seen.push(
          await auth.storage.findMany("member", [
            { field: "organizationId", op: "eq", value: e.organization.id },
          ]),
        );
      },
    });
    const ada = await auth.seedUser("ada@example.com");
    const c = await createOrganization(auth.config, { user: ada, slug: "acme", name: "Acme" });
    if (!c.ok) throw new Error(c.code);
    const id = c.value.organization.id;
    const u = await updateOrganization(auth.config, { user: ada, organizationId: id, name: "Two" });
    expect(u.ok).toBe(true);
    expect(seen[0]).toMatchObject({ name: "Acme" });
    expect((await deleteOrganization(auth.config, { user: ada, organizationId: id })).ok).toBe(
      true,
    );
    expect(seen[1]).toHaveLength(1);
  });

  it("answers hook_failed and keeps the rows when beforeUpdate or beforeDelete throws a plain Error (parked Minor 7)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { auth, names } = recorded({
      beforeUpdate() {
        throw new Error("audit store down");
      },
      beforeDelete() {
        throw new Error("audit store down");
      },
    });
    const ada = await auth.seedUser("ada@example.com");
    const c = await createOrganization(auth.config, { user: ada, slug: "acme", name: "Acme" });
    if (!c.ok) throw new Error(c.code);
    const id = c.value.organization.id;
    expect(
      await updateOrganization(auth.config, { user: ada, organizationId: id, name: "Two" }),
    ).toEqual({ ok: false, code: "hook_failed", status: 500 });
    expect(await deleteOrganization(auth.config, { user: ada, organizationId: id })).toEqual({
      ok: false,
      code: "hook_failed",
      status: 500,
    });
    expect(
      await auth.storage.findOne("organization", [{ field: "id", op: "eq", value: id }]),
    ).toMatchObject({ name: "Acme" });
    expect(await auth.storage.findMany("member", [])).toHaveLength(1);
    expect(names()).not.toContain("afterUpdate");
    expect(names()).not.toContain("afterDelete");
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("runs no update hook for a slug that is taken (parked Minor 7)", async () => {
    const { auth, calls, names } = recorded();
    const ada = await auth.seedUser("ada@example.com");
    const a = await createOrganization(auth.config, { user: ada, slug: "acme", name: "A" });
    const b = await createOrganization(auth.config, { user: ada, slug: "other", name: "B" });
    if (!a.ok || !b.ok) throw new Error("create");
    calls.length = 0;
    expect(
      await updateOrganization(auth.config, {
        user: ada,
        organizationId: b.value.organization.id,
        slug: "acme",
      }),
    ).toMatchObject({ ok: false, code: "slug_taken" });
    expect(names()).toEqual([]);
  });
});
