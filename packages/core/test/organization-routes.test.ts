import { describe, expect, it } from "vitest";
import { createSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { organizationRoutes } from "../src/http/routes/organizations.js";
import type { UserRow } from "../src/schema.js";
import { BASE_URL, get, makeAuth, post } from "./helpers.js";

const P = "/auth/organizations";

function setup(over: Parameters<typeof makeAuth>[0] = { organizations: {} }) {
  const auth = makeAuth(over);
  const handle = createRouter(auth.config, organizationRoutes(auth.config));
  async function cookieFor(user: UserRow) {
    const { token } = await createSession(auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    return { cookie: `${auth.config.cookieName}=${token}` };
  }
  return { auth, handle, cookieFor };
}

// biome-ignore lint/suspicious/noExplicitAny: test reads loose JSON
async function body(res: Response): Promise<any> {
  return res.json();
}

async function createAcme(s: ReturnType<typeof setup>, user: UserRow) {
  const h = await s.cookieFor(user);
  const res = await s.handle(post(`${P}/create`, { slug: "acme", name: "Acme" }, h));
  const b = await body(res);
  return { h, id: b.organization.id as string };
}

describe("organization routes: create and list", () => {
  it("creates, lists, and refuses without a session, with organizations off, and with a bad body", async () => {
    const s = setup();
    const ada = await s.auth.seedUser("ada@example.com");
    const h = await s.cookieFor(ada);
    const res = await s.handle(post(`${P}/create`, { slug: "acme", name: "Acme" }, h));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      organization: { slug: "acme" },
      member: { role: "owner" },
    });
    const list = await s.handle(get(P, h));
    expect(list.status).toBe(200);
    expect(await body(list)).toMatchObject({
      organizations: [{ organization: { slug: "acme" }, role: "owner" }],
    });
    const anon = await s.handle(post(`${P}/create`, { slug: "x", name: "X" }));
    expect(anon.status).toBe(401);
    const bad = await s.handle(post(`${P}/create`, { slug: "x" }, h));
    expect(bad.status).toBe(400);
    expect(await body(bad)).toEqual({ error: "invalid_body" });
    const long = await s.handle(post(`${P}/create`, { slug: "x", name: "n".repeat(121) }, h));
    expect(long.status).toBe(400);
    // Off: the route does not exist, so the router answers 404.
    const off = setup({});
    const user = await off.auth.seedUser("ada@example.com");
    const offRes = await off.handle(
      post(`${P}/create`, { slug: "acme", name: "Acme" }, await off.cookieFor(user)),
    );
    expect(offRes.status).toBe(404);
  });

  it("updates and deletes an organization", async () => {
    const s = setup();
    const ada = await s.auth.seedUser("ada@example.com");
    const { h, id } = await createAcme(s, ada);
    const up = await s.handle(post(`${P}/update`, { organizationId: id, name: "Acme 2" }, h));
    expect(up.status).toBe(200);
    expect(await body(up)).toMatchObject({ organization: { name: "Acme 2" } });
    const del = await s.handle(post(`${P}/delete`, { organizationId: id }, h));
    expect(del.status).toBe(200);
    expect(await body(del)).toEqual({ ok: true });
  });
});

describe("organization routes: members", () => {
  it("adds, changes the role of, lists, and removes a member", async () => {
    const s = setup();
    const ada = await s.auth.seedUser("ada@example.com");
    const bob = await s.auth.seedUser("bob@example.com");
    const { h, id } = await createAcme(s, ada);
    const add = await s.handle(
      post(`${P}/members/add`, { organizationId: id, userId: bob.id, role: "member" }, h),
    );
    expect(add.status).toBe(200);
    expect(await body(add)).toMatchObject({ member: { userId: bob.id, role: "member" } });
    const role = await s.handle(
      post(`${P}/members/role`, { organizationId: id, userId: bob.id, role: "admin" }, h),
    );
    expect(role.status).toBe(200);
    expect(await body(role)).toMatchObject({ member: { role: "admin" } });
    const list = await s.handle(get(`${P}/members?organizationId=${id}`, h));
    expect(list.status).toBe(200);
    expect((await body(list)).members).toHaveLength(2);
    const noId = await s.handle(get(`${P}/members`, h));
    expect(noId.status).toBe(400);
    expect(await body(noId)).toEqual({ error: "invalid_body" });
    const rm = await s.handle(
      post(`${P}/members/remove`, { organizationId: id, userId: bob.id }, h),
    );
    expect(rm.status).toBe(200);
    expect(await body(rm)).toEqual({ ok: true });
  });
});

describe("organization routes: invitations", () => {
  it("invites without leaking the token, lists, accepts, refuses a wrong user, declines, and revokes", async () => {
    const s = setup();
    const ada = await s.auth.seedUser("ada@example.com");
    const bob = await s.auth.seedUser("bob@example.com");
    const cy = await s.auth.seedUser("cy@example.com");
    const { h, id } = await createAcme(s, ada);
    const inv = await s.handle(
      post(`${P}/invite`, { organizationId: id, email: "bob@example.com", role: "member" }, h),
    );
    expect(inv.status).toBe(200);
    const text = await inv.text();
    expect(JSON.parse(text)).toMatchObject({ invitation: { email: "bob@example.com" } });
    expect(text).not.toContain("inv_");
    expect(text).not.toContain("token");
    const token = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(s.auth.mail[0]?.text ?? "")?.[1] ?? "";
    expect(token).toMatch(/^inv_/);
    const list = await s.handle(get(`${P}/invitations?organizationId=${id}`, h));
    expect(list.status).toBe(200);
    expect((await body(list)).invitations).toHaveLength(1);

    const wrong = await s.handle(post(`${P}/invitations/accept`, { token }, await s.cookieFor(cy)));
    expect(wrong.status).toBe(403);
    expect(await body(wrong)).toEqual({ error: "email_mismatch" });
    const ok = await s.handle(post(`${P}/invitations/accept`, { token }, await s.cookieFor(bob)));
    expect(ok.status).toBe(200);
    expect(await body(ok)).toMatchObject({
      organization: { slug: "acme" },
      member: { role: "member" },
    });

    await s.handle(
      post(`${P}/invite`, { organizationId: id, email: "cy@example.com", role: "member" }, h),
    );
    const t2 = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(s.auth.mail[1]?.text ?? "")?.[1] ?? "";
    const decline = await s.handle(post(`${P}/invitations/decline`, { token: t2 }));
    expect(decline.status).toBe(200);
    expect(await body(decline)).toEqual({ ok: true });

    await s.handle(
      post(`${P}/invite`, { organizationId: id, email: "dee@example.com", role: "member" }, h),
    );
    const pending = (await body(await s.handle(get(`${P}/invitations?organizationId=${id}`, h))))
      .invitations;
    const revoke = await s.handle(
      post(`${P}/invitations/revoke`, { organizationId: id, invitationId: pending[0].id }, h),
    );
    expect(revoke.status).toBe(200);
    expect(await body(revoke)).toEqual({ ok: true });
  });
});

describe("organization routes: active", () => {
  it("sets, clears, and refuses a non-member and a missing field", async () => {
    const s = setup();
    const ada = await s.auth.seedUser("ada@example.com");
    const bob = await s.auth.seedUser("bob@example.com");
    const { h, id } = await createAcme(s, ada);
    const set = await s.handle(post(`${P}/active`, { organizationId: id }, h));
    expect(set.status).toBe(200);
    expect(await body(set)).toMatchObject({ session: { activeOrganizationId: id } });
    const clear = await s.handle(post(`${P}/active`, { organizationId: null }, h));
    expect(clear.status).toBe(200);
    expect((await body(clear)).session.activeOrganizationId).toBeNull();
    const out = await s.handle(post(`${P}/active`, { organizationId: id }, await s.cookieFor(bob)));
    expect(out.status).toBe(403);
    expect(await body(out)).toEqual({ error: "forbidden_rank" });
    const missing = await s.handle(post(`${P}/active`, {}, h));
    expect(missing.status).toBe(400);
  });
});

describe("organization routes: origin", () => {
  it("refuses a POST from an untrusted Origin", async () => {
    const s = setup();
    const ada = await s.auth.seedUser("ada@example.com");
    const h = await s.cookieFor(ada);
    const res = await s.handle(
      new Request(`${BASE_URL}${P}/create`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          cookie: h.cookie,
        },
        body: JSON.stringify({ slug: "acme", name: "Acme" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: "origin_not_trusted" });
  });
});
