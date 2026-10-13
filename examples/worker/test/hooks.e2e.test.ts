import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { lastLink, signIn } from "./helpers.js";

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
  // The marker shows that the hook ran and then threw (parked Minor 23).
  expect(
    await env.DB.prepare("SELECT name FROM app_tenant WHERE organization_id = ?")
      .bind(failing.value.organization.id)
      .first(),
  ).toEqual({ name: "marker: the after hook ran" });
});

it("undoes the owner lock stamp of a refused owner demotion on D1 (final fix wave M-6)", async () => {
  const ada = await signIn("hooks-lock-ada@example.com");
  const grace = await signIn("hooks-lock-grace@example.com");
  const me = await grace.session();
  if (!me.ok || !me.value) throw new Error("no session");
  const created = await ada.organizations.create({ slug: "locked-co", name: "Locked Co" });
  if (!created.ok) throw new Error(created.code);
  const organizationId = created.value.organization.id;
  const added = await ada.organizations.members.add({
    organizationId,
    userId: me.value.user.id,
    role: "owner",
  });
  if (!added.ok) throw new Error(added.code);
  const rows = () =>
    Promise.all([
      env.DB.prepare("SELECT updated_at FROM ta_organization WHERE id = ?")
        .bind(organizationId)
        .first(),
      env.DB.prepare(
        "SELECT user_id, role, updated_at FROM ta_member WHERE organization_id = ? ORDER BY user_id",
      )
        .bind(organizationId)
        .all()
        .then((r) => r.results),
    ]);
  const before = await rows();
  expect(
    await ada.organizations.members.role({
      organizationId,
      userId: me.value.user.id,
      role: "member",
    }),
  ).toEqual({ ok: false, code: "hook_refused", status: 403, message: "Roles are locked here." });
  expect(await rows()).toEqual(before);
});

it("undoes the consume of a refused reset on D1, and keeps the user's rows (final fix wave M-6)", async () => {
  const email = "hooks-reset-refused@example.com";
  const client = await signIn(email);
  const user = await env.DB.prepare("SELECT id FROM ta_user WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!user) throw new Error("no user");
  expect((await client.password.requestReset({ email })).ok).toBe(true);
  const token = (await lastLink()).searchParams.get("token") ?? "";
  const rows = () =>
    Promise.all([
      env.DB.prepare(
        "SELECT id, consumed_at FROM ta_verification WHERE purpose = 'password-reset' AND identifier = ?",
      )
        .bind(email)
        .all()
        .then((r) => r.results),
      env.DB.prepare("SELECT id FROM ta_password WHERE user_id = ?")
        .bind(user.id)
        .all()
        .then((r) => r.results),
      env.DB.prepare("SELECT id, expires_at FROM ta_session WHERE user_id = ? ORDER BY id")
        .bind(user.id)
        .all()
        .then((r) => r.results),
    ]);
  const before = await rows();
  expect(before[0]).toEqual([expect.objectContaining({ consumed_at: null })]);
  expect(before[2]).toHaveLength(1);
  expect(await client.password.reset({ token, password: "another long password" })).toEqual({
    ok: false,
    code: "hook_refused",
    status: 403,
    message: "Password sign-in is closed for this account.",
  });
  expect(await rows()).toEqual(before);
  // The magic link session is still live: the undo kept it.
  expect(await client.session()).toMatchObject({ ok: true, value: { user: { id: user.id } } });
});
