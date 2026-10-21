import { createAuth } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The set-based delete of the solo organizations on Postgres (ruling 30 of
// plan 12d). The scene is the one of core account-delete-organizations.test.ts
// on memory, and the rows left are the same literal.

const APP = { kind: "app", name: "delete-test" } as const;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

describe("the solo organizations of an account delete on Postgres (ruling 30 of plan 12d)", () => {
  it("leaves the rows that the memory run leaves", async () => {
    const mail: string[] = [];
    const storage = createPostgresAdapter(db.sql);
    const auth = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage,
      limiter: { allow: async () => true },
      mail: { send: async (m) => void mail.push(m.text) },
      organizations: {},
      sso: { dns: [{ name: "a", txt: async () => [] }] },
    });
    const signIn = async (email: string) => {
      await auth.api.requestMagicLink({ email, ip: null });
      const token = decodeURIComponent(
        /token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "",
      );
      const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
      if (!r.ok || !("token" in r.value)) throw new Error("no session");
      const s = await auth.api.getSession(r.value.token);
      if (!s) throw new Error("no session");
      return s;
    };
    const ada = await signIn("ada@example.com");
    const bob = await signIn("bob@example.com");
    const ids: string[] = [];
    for (const [user, slug] of [
      [ada.user, "solo-0"],
      [ada.user, "solo-1"],
      [bob.user, "solo-10"],
    ] as const) {
      const made = await auth.api.createOrganization({ user, slug, name: slug });
      if (!made.ok) throw new Error(made.code);
      ids.push(made.value.organization.id);
    }
    const shared = ids[2] ?? "";
    const joined = await auth.api.addMember({
      user: bob.user,
      organizationId: shared,
      userId: ada.user.id,
      role: "member",
    });
    expect(joined.ok).toBe(true);
    for (const [i, organizationId] of ids.entries()) {
      const d = await auth.api.sso?.domains.add({
        actor: APP,
        organizationId,
        domain: `d${i}.example`,
      });
      expect(d?.ok).toBe(true);
    }
    const done = await auth.api.user.delete({ session: ada, ip: null, userAgent: null });
    expect(done.ok).toBe(true);
    const left = {
      user: (await storage.findMany("user", [])).length,
      organization: (await storage.findMany("organization", [])).length,
      member: (await storage.findMany("member", [])).length,
      ssoDomain: (await storage.findMany("ssoDomain", [])).map((x) => x.domain),
    };
    // The same literal as core account-delete-organizations.test.ts.
    expect(left).toEqual({ user: 1, organization: 1, member: 1, ssoDomain: ["d2.example"] });
  });
});
