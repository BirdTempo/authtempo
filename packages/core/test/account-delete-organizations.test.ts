import { describe, expect, it } from "vitest";
import { addMember, createOrganization } from "../src/engine/organizations.js";
import { addDomain } from "../src/engine/sso/domains.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { IN_CHUNK } from "../src/storage/batch.js";
import { post } from "./helpers.js";
import { fakeDns, SSO_APP } from "./sso/helpers.js";
import { totpAuth, verifiedSession } from "./totp-helpers.js";

/**
 * The account delete of the solo organizations of a user, set-based (ruling
 * 30 of plan 12d). One delete takes at most IN_CHUNK of them. More answer
 * delete_too_large before any write. The D1 counts are in adapter-d1
 * account-delete-budget.test.ts.
 */

/** A world with organizations, sso, and the mailed confirm as `confirm` says. */
function world(confirm: boolean) {
  const auth = totpAuth({
    organizations: {},
    sso: { dns: [fakeDns("a", {})] },
    ...(confirm ? { account: { deleteConfirm: { ttlMinutes: 60 } } } : {}),
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  return { auth, handle };
}

/** `n` organizations that the user alone holds, made through the engine, from `from` on. */
async function soloOrganizations(
  w: ReturnType<typeof world>,
  user: Parameters<typeof createOrganization>[1]["user"],
  n: number,
  from = 0,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = from; i < from + n; i++) {
    const made = await createOrganization(w.auth.config, {
      user,
      slug: `solo-${i}`,
      name: `Solo ${i}`,
    });
    if (!made.ok) throw new Error(made.code);
    ids.push(made.value.organization.id);
  }
  return ids;
}

const count = async (w: ReturnType<typeof world>, model: "organization" | "member" | "user") =>
  (await w.auth.storage.findMany(model, [])).length;

describe("the solo organizations of an account delete (ruling 30 of plan 12d)", () => {
  it("deletes IN_CHUNK solo organizations in one delete, and refuses one more before any write", async () => {
    expect(IN_CHUNK).toBe(50);
    const w = world(false);
    const ada = await verifiedSession(w.auth, "ada@example.com");
    await soloOrganizations(w, ada.user, 51);
    const cookie = { cookie: `__Host-tempo_session=${ada.token}` };
    const res = await w.handle(post("/auth/user/delete", {}, cookie));
    expect([res.status, await res.json()]).toEqual([409, { error: "delete_too_large" }]);
    // Nothing changed: the user, the session, and the 51 organizations stay.
    expect([
      await count(w, "user"),
      await count(w, "organization"),
      await count(w, "member"),
    ]).toEqual([1, 51, 51]);
    expect(
      await w.auth.storage.findOne("session", [{ field: "id", op: "eq", value: ada.session.id }]),
    ).not.toBeNull();
    // At 50 the delete takes them all.
    const bob = await verifiedSession(w.auth, "bob@example.com");
    await soloOrganizations(w, bob.user, 50, 100);
    const done = await w.handle(
      post("/auth/user/delete", {}, { cookie: `__Host-tempo_session=${bob.token}` }),
    );
    expect(done.status).toBe(200);
    expect([await count(w, "user"), await count(w, "organization")]).toEqual([1, 51]);
  });

  it("refuses the mailed confirm when the user holds one solo organization too many", async () => {
    const w = world(true);
    const ada = await verifiedSession(w.auth, "ada@example.com");
    await soloOrganizations(w, ada.user, 50);
    const cookie = { cookie: `__Host-tempo_session=${ada.token}` };
    expect((await w.handle(post("/auth/user/delete", {}, cookie))).status).toBe(200);
    const link = w.auth.mail.findLast((m) => m.text.includes("/user/delete/confirm?token="));
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(link?.text ?? "")?.[1] ?? "");
    // One more solo organization after the request.
    await soloOrganizations(w, ada.user, 1, 50);
    const res = await w.handle(post("/auth/user/delete/confirm", { token }, cookie));
    expect([res.status, await res.json()]).toEqual([409, { error: "delete_too_large" }]);
    expect([await count(w, "user"), await count(w, "organization")]).toEqual([1, 51]);
    // The request also refuses it now, and mails no new link.
    const mails = w.auth.mail.length;
    const again = await w.handle(post("/auth/user/delete", {}, cookie));
    expect([again.status, w.auth.mail.length]).toEqual([409, mails]);
  });

  it("leaves the rows that the Postgres run leaves (memory)", async () => {
    const w = world(false);
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const bob = await verifiedSession(w.auth, "bob@example.com");
    const solo = await soloOrganizations(w, ada.user, 2);
    const shared = await soloOrganizations(w, bob.user, 1, 10);
    const sharedId = shared[0] ?? "";
    expect(await count(w, "organization")).toBe(3);
    const joined = await addMember(w.auth.config, {
      user: bob.user,
      organizationId: sharedId,
      userId: ada.user.id,
      role: "member",
    });
    expect(joined.ok).toBe(true);
    for (const [i, organizationId] of [...solo, sharedId].entries()) {
      const d = await addDomain(w.auth.config, SSO_APP, {
        organizationId,
        domain: `d${i}.example`,
      });
      expect(d.ok).toBe(true);
    }
    const res = await w.handle(
      post("/auth/user/delete", {}, { cookie: `__Host-tempo_session=${ada.token}` }),
    );
    expect(res.status).toBe(200);
    const left = {
      user: await count(w, "user"),
      organization: await count(w, "organization"),
      member: await count(w, "member"),
      ssoDomain: (await w.auth.storage.findMany("ssoDomain", [])).map((x) => x.domain),
    };
    // The same literal as adapter-postgres account-delete-organizations.test.ts.
    expect(left).toEqual({ user: 1, organization: 1, member: 1, ssoDomain: ["d2.example"] });
  });
});
