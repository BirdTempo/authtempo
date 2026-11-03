import { describe, expect, it } from "vitest";
import { type CopySsoReport, copyBetterAuthSso } from "../src/copy-sso.js";
import { organization, twoFactor } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { scim, sso } from "../src/sso.js";
import type { D1SchemaStorage, PostgresSchemaStorage } from "../src/storage/index.js";
import { BASE, fakeDns, SECRET } from "./sso-helpers.js";

/**
 * One database of the copy suite (plan 12d Task 14). It holds Better Auth's
 * own tables and the rows that Better Auth 1.7.2 wrote with sso and scim
 * (better-auth-sso-scim-1.7.2-rows). Then come the compat migrations, as an
 * app that moves holds them. `fresh` gives the storage of a new invocation.
 * `statements` counts what that storage sent, where the setup can count.
 */
export interface CopyDatabase {
  fresh(): { database: PostgresSchemaStorage | D1SchemaStorage; statements(): number | null };
  close(): Promise<void>;
}

/** The static token of the scim connection of the fixture (script plan-12d-task-14-gen2.mjs). */
const TOKEN = "ba-scim-token-acme-0123456789abcdef";
const APP = { kind: "app", name: "copy-test" } as const;

export function copySsoSuite(name: string, setup: () => Promise<CopyDatabase>) {
  describe(`copyBetterAuthSso on ${name} (plan 12d Task 14)`, () => {
    // In the logs of 2026-10-30 to 2026-11-03 this test did not time out. Its highest pass is
    // 3.09 s on Postgres, in the evidence run 12j-integ1 of 2026-10-30 (sampled peak load 55.9).
    // On D1 its highest pass is 2.46 s. So both runs get 20 s, the limit of the compat D1 pool.
    it("copies providers, domains, tokens, and SCIM rows once", { timeout: 20_000 }, async () => {
      const db = await setup();
      try {
        const answers = new Map<string, string[]>();
        const dns = fakeDns("a", answers);
        /** The shim app of one invocation, on a new storage of the same database. */
        const appOf = (organizationId: string) => {
          const { database, statements } = db.fresh();
          const auth = betterAuth({
            baseURL: BASE,
            secret: SECRET,
            database,
            authtempo: { ssoDns: [dns.port] },
            emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
            emailVerification: { sendVerificationEmail: async () => {} },
            plugins: [
              organization({ sendInvitationEmail: async () => {} }),
              twoFactor({ accountLockout: { enabled: false } }),
              sso({ domainVerification: { enabled: true } }),
              scim({
                connections: [
                  {
                    id: "acme-directory",
                    provisioningDomainId: organizationId,
                    credentials: [{ type: "bearer", id: "entra-1", token: TOKEN }],
                  },
                ],
              }),
            ],
          });
          return { auth, database, statements };
        };
        const first = db.fresh().database.storage;
        const acme = await first.findOne("organization", [
          { field: "slug", op: "eq", value: "acme" },
        ]);
        if (!acme) throw new Error("no organization in the fixture");
        // The owner proves acme.example in core first, through the app's verify on a fake DNS.
        const setupApp = appOf(acme.id);
        const api = setupApp.auth.tempo.api.sso;
        if (!api) throw new Error("no sso api");
        const added = await api.domains.add({
          actor: APP,
          organizationId: acme.id,
          domain: "acme.example",
        });
        if (!added.ok || !added.value.record) throw new Error("no domain");
        answers.set(added.value.record.name, [added.value.record.value]);
        expect((await api.domains.verify({ actor: APP, id: added.value.id })).ok).toBe(true);

        /** Every call until `next` is null, each on a new invocation. */
        const run = async () => {
          const reports: CopySsoReport[] = [];
          const counts: (number | null)[] = [];
          let after: string | null = null;
          for (let i = 0; i < 40; i++) {
            const one = appOf(acme.id);
            const r = await copyBetterAuthSso(one.auth, { after });
            reports.push(r);
            counts.push(one.statements());
            if (r.next === null) break;
            after = r.next;
          }
          const sum = (
            k: "connections" | "domains" | "scimUsers" | "scimGroups" | "scimGroupMembers",
          ) => reports.reduce((n, r) => n + r[k], 0);
          return {
            reports,
            counts,
            totals: [
              sum("connections"),
              sum("domains"),
              sum("scimUsers"),
              sum("scimGroups"),
              sum("scimGroupMembers"),
            ],
            skipped: reports.flatMap((r) => r.skipped),
            changed: reports.flatMap((r) => r.changed),
          };
        };
        const once = await run();
        expect(once.reports.at(-1)?.next).toBeNull();
        // Three providers, three domains, alice and carl, the group, and its two members.
        expect(once.totals).toEqual([3, 3, 2, 1, 2]);
        // bob@other.example fails core's address rule, with core's reason.
        expect(once.skipped).toHaveLength(1);
        expect(once.skipped[0]?.reason).toMatch(/^scim 400 invalidValue: /);
        // Each call stays inside the D1 budget of one invocation.
        for (const c of once.counts) if (c !== null) expect(c).toBeLessThanOrEqual(50);
        // What changes in core is in the answer, never silent.
        const reasons = once.changed.map((c) => c.reason.split(":")[0]);
        // Core keeps client_secret_basic (12d fix wave item 18), so the two basic rows change nothing.
        expect(reasons.filter((r) => r === "tokenEndpointAuthentication")).toHaveLength(0);
        expect(reasons.filter((r) => r === "redirectURI")).toHaveLength(2);
        expect(reasons.filter((r) => r === "samlConfig")).toHaveLength(1);
        expect(reasons.filter((r) => r === "domain")).toHaveLength(1);

        const storage = first;
        const connections = await storage.findMany("ssoConnection", []);
        expect(connections.map((c) => [c.label, c.kind]).sort()).toEqual([
          ["acme-oidc", "oidc"],
          ["beta-oidc", "oidc"],
          ["gamma-saml", "saml"],
        ]);
        // Each OIDC row of the fixture holds client_secret_basic, and the copy keeps it.
        expect(
          connections
            .filter((c) => c.kind === "oidc")
            .map((c) => (c.config as { tokenEndpointAuthMethod?: string }).tokenEndpointAuthMethod),
        ).toEqual(["client_secret_basic", "client_secret_basic"]);
        // No copied connection holds a clear client secret: core sealed each one.
        const text = JSON.stringify(connections);
        expect(text).not.toContain("acme-secret-value");
        expect(text).not.toContain("beta-secret-value");
        expect(
          connections
            .filter((c) => c.kind === "oidc")
            .every((c) => typeof c.clientSecret === "string"),
        ).toBe(true);
        // A verified Better Auth domain is pending in core; the domain that core proved holds its claim.
        const domains = await storage.findMany("ssoDomain", []);
        const byName = (d: string) => domains.find((r) => r.domain === d);
        expect(byName("beta.example")?.claimedDomain).toBeNull();
        expect(byName("acme.example")?.claimedDomain).toBe("acme.example");
        expect(byName("gamma.example")?.claimedDomain).toBeNull();
        for (const d of domains)
          expect(d.connectionId, d.domain).toBe(
            connections.find(
              (c) =>
                c.label ===
                `${d.domain.split(".")[0]}-${d.domain === "gamma.example" ? "saml" : "oidc"}`,
            )?.id,
          );
        const users = await storage.findMany("scimUser", []);
        expect(users.map((u) => [u.userName, u.externalId]).sort()).toEqual([
          ["alice@acme.example", "ext-alice"],
          ["carl@acme.example", "ext-carl"],
        ]);
        const groups = await storage.findMany("scimGroup", []);
        expect(groups.map((g) => [g.displayName, g.externalId])).toEqual([
          ["Engineering", "ext-eng"],
        ]);
        const members = await storage.findMany("scimGroupMember", []);
        expect(members.map((m) => m.scimUserId).sort()).toEqual(users.map((u) => u.id).sort());

        // A second run copies nothing twice.
        const twice = await run();
        expect(twice.totals).toEqual([0, 0, 0, 0, 0]);
        expect(twice.skipped.map((s) => s.reason.split(":")[0]).sort()).toEqual([
          "present",
          "present",
          "present",
          "present",
          "present",
          "present",
          "present",
          "present",
          "scim 400 invalidValue",
        ]);
        expect(await storage.findMany("ssoConnection", [])).toHaveLength(3);
        expect(await storage.findMany("scimUser", [])).toHaveLength(2);
      } finally {
        await db.close();
      }
    });
  });
}
