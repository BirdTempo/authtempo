import { env } from "cloudflare:test";
import { type AuthConfig, createAuth } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The D1 order of a team member add beside an account delete (ruling 53 P2
// of plan 12d). D1 has no row lock, so the batch hold of the add
// (`holdUsers`) sends nothing there. The read after the insert
// (`usersStay`) is the one check: an account delete that ends between the
// checks of the add and its insert makes the add stop, and the undo log
// takes the new team member row back. The delete runs inside the before
// hook of the add, so the order is fixed on one binding.

const mail: { to: string; text: string }[] = [];

function make(hooks: AuthConfig["hooks"] = {}) {
  return createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(env.DB),
    limiter: { allow: async () => true },
    mail: { send: async (m) => void mail.push({ to: m.to, text: m.text }) },
    organizations: { teams: {} },
    hooks,
  });
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  mail.length = 0;
});

/** A magic link sign-in of `email`: the user and the session token. */
async function signIn(auth: ReturnType<typeof make>, email: string) {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = mail.filter((m) => m.to === email).at(-1)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return { user: r.value.user, token: r.value.token };
}

const count = async (table: string) =>
  Number(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"));

describe("the team member add beside an account delete on D1 (ruling 53 P2 of plan 12d)", () => {
  it("leaves no team member row of a deleted user", async () => {
    const plain = make();
    const ada = await signIn(plain, "ada@example.com");
    const bob = await signIn(plain, "bob@example.com");
    const org = await plain.api.createOrganization({ user: ada.user, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    const organizationId = org.value.organization.id;
    const added = await plain.api.addMember({
      user: ada.user,
      organizationId,
      userId: bob.user.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    const team = await plain.api.createTeam({ user: ada.user, organizationId, name: "Core" });
    if (!team.ok) throw new Error(team.code);
    const session = await plain.api.getSession(bob.token);
    if (!session) throw new Error("no session");
    let deleted: unknown = null;
    // Bob deletes his account after the checks of the add and before its insert.
    const racing = make({
      organization: {
        beforeAddTeamMember: async () => {
          deleted = await plain.api.user.delete({ session, ip: null, userAgent: null });
        },
      },
    });

    const r = await racing.api.addTeamMember({
      user: ada.user,
      teamId: team.value.id,
      userId: bob.user.id,
    });

    expect(deleted).toEqual({ ok: true, value: { ok: true } });
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(await count("ta_team_member")).toBe(0);
    expect(await count("ta_user")).toBe(1);
  });
});
