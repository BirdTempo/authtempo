import { describe, expect, it } from "vitest";
import { organization } from "../src/plugins.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import { scim, sso } from "../src/sso.js";
import type { BetterAuthOptions, ScimOptions } from "../src/types.js";
import { BASE, memory, SECRET, ssoApp } from "./sso-helpers.js";

// Plan 12d Task 14: @better-auth/scim 1.7.2 on core's SCIM server. The
// option names were read in the 1.7.2 tarball on 2026-10-22 (dist/index.d.mts).

const TOKEN = "ba-scim-token-acme-0123456789abcdef";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";

function withScim(o: ScimOptions): BetterAuthOptions {
  return {
    baseURL: BASE,
    secret: SECRET,
    database: memory(),
    plugins: [organization({ sendInvitationEmail: async () => {} }), scim(o)],
  };
}

const connection = (organizationId: string, extra: Record<string, unknown> = {}) => ({
  id: "acme-directory",
  provisioningDomainId: organizationId,
  credentials: [{ type: "bearer" as const, id: "entra-1", token: TOKEN, ...extra }],
});

describe("the scim plugin (plan 12d Task 14)", () => {
  it("maps a credential to a hashed SCIM token", async () => {
    // The organization id is known before the plugin. A first app makes the
    // organization and proves the domain. A second app on the same database
    // holds the credential, as an app adds the plugin after its setup.
    const database = memory();
    const setup = ssoApp(database, [sso({ domainVerification: { enabled: true } })]);
    const owner = await setup.person("ann@acme.example");
    const organizationId = await setup.organizationOf(owner, "acme");
    const actor = { kind: "app", name: "test" } as const;
    const added = await setup.auth.tempo.api.sso?.domains.add({
      actor,
      organizationId,
      domain: "acme.example",
    });
    if (!added?.ok || !added.value.record) throw new Error("no domain");
    setup.dns.set(added.value.record.name, [added.value.record.value]);
    expect(
      (await setup.auth.tempo.api.sso?.domains.verify({ actor, id: added.value.id }))?.ok,
    ).toBe(true);

    const plugin = scim({
      connections: [
        connection(organizationId, { scopes: ["scim.users.read", "scim.users.write"] }),
      ],
    });
    const app = ssoApp(database, [sso({ domainVerification: { enabled: true } }), plugin]);
    // The marker, the mapped options, and the storage hold no clear token.
    expect(JSON.stringify(plugin)).not.toContain(TOKEN);
    const mapped = mapOptions({
      baseURL: BASE,
      secret: SECRET,
      database,
      authtempo: { ssoDns: [setup.a.port] },
      plugins: [organization({ sendInvitationEmail: async () => {} }), plugin],
    });
    expect(JSON.stringify(mapped.scim)).not.toContain(TOKEN);
    expect(mapped.scim?.credentials).toEqual([
      {
        id: "acme-directory:entra-1",
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        organizationId,
        scopes: ["scim.users.read", "scim.users.write"],
        expiresAt: null,
      },
    ]);
    const scimCall = (method: string, path: string, token: string, body?: unknown) =>
      app.auth.handler(
        new Request(`${BASE}/api/auth/scim/v2${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    // A call with the clear token passes, on core's own route and with its rules.
    const made = await scimCall("POST", "/Users", TOKEN, {
      schemas: [USER],
      userName: "alice@acme.example",
      externalId: "ext-alice",
      emails: [{ value: "alice@acme.example", primary: true }],
    });
    expect(made.status).toBe(201);
    const alice = (await made.json()) as { id: string; userName: string };
    expect(alice.userName).toBe("alice@acme.example");
    const read = await scimCall("GET", `/Users/${alice.id}`, TOKEN);
    expect(read.status).toBe(200);
    expect((await scimCall("GET", "/ServiceProviderConfig", TOKEN)).status).toBe(200);
    // Core's address rule holds for the credential too.
    const outside = await scimCall("POST", "/Users", TOKEN, {
      schemas: [USER],
      userName: "bob@other.example",
    });
    expect(outside.status).toBe(400);
    // The credential's scopes hold: no group scope, so 403.
    expect((await scimCall("GET", "/Groups", TOKEN)).status).toBe(403);
    // Another token, or a near one, answers core's 401.
    for (const wrong of [`${TOKEN}x`, "sk_unknown", ""]) {
      const res = await scimCall("GET", "/Users", wrong);
      expect(res.status, wrong).toBe(401);
    }
    // The audit row names the shim's caller, the credential, and never the token (ruling 61 P3).
    const rows = await database.storage.findMany("operatorAudit", [
      { field: "actorKind", op: "eq", value: "scim" },
    ]);
    expect(rows.map((r) => [r.action, r.actorId])).toEqual([
      ["scim_user_create", "acme-directory:entra-1"],
    ]);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    // The same request with no mark, sent to core itself, answers core's 401.
    const unmarked = await app.auth.tempo.handle(
      new Request(`${BASE}/api/auth/scim/v2/Users/${alice.id}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(unmarked.status).toBe(401);
    // The storage holds no clear token in a row of any SCIM or audit model.
    for (const model of ["scimToken", "scimUser", "operatorAudit"] as const)
      expect(JSON.stringify(await database.storage.findMany(model, [])), model).not.toContain(
        TOKEN,
      );

    // An expired credential answers 401.
    const late = ssoApp(database, [
      sso({ domainVerification: { enabled: true } }),
      scim({
        connections: [connection(organizationId, { expiresAt: new Date(Date.UTC(2020, 0, 1)) })],
      }),
    ]);
    const res = await late.auth.handler(
      new Request(`${BASE}/api/auth/scim/v2/Users`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("refuses each scim option with no core feature", () => {
    const base = { connections: [connection("org-1")] };
    const rows: [ScimOptions, string][] = [
      [
        { ...base, authentication: { verifyBearerToken: () => null } },
        "plugins[scim].authentication: ",
      ],
      [
        { ...base, identity: { resolveUser: () => ({ action: "create" }) } },
        "plugins[scim].identity: ",
      ],
      [{ ...base, projection: { reconcileUser: () => {} } }, "plugins[scim].projection: "],
      [
        { ...base, managedConnections: { credentialHashSecret: "x".repeat(32) } },
        "plugins[scim].managedConnections: ",
      ],
      [
        { connections: [{ ...connection("org-1"), credentials: [] }] },
        "plugins[scim].connections[0].credentials: ",
      ],
      [
        { connections: [connection("org-1", { token: "" })] },
        "plugins[scim].connections[0].credentials[0].token: ",
      ],
      [
        { connections: [connection("org-1", { scopes: ["scim.users.admin"] })] },
        "plugins[scim].connections[0].credentials[0].scopes: ",
      ],
      [
        { connections: [connection("org-1"), connection("org-1")] },
        "plugins[scim].connections[1].id: ",
      ],
      [
        { connections: [connection("org-1", { type: "basic" })] },
        "plugins[scim].connections[0].credentials[0].type: ",
      ],
      [
        { connections: [connection("org-1", { id: "a b" })] },
        "plugins[scim].connections[0].credentials[0].id: ",
      ],
      [
        { connections: [connection("org-1", { expiresAt: "2030" })] },
        "plugins[scim].connections[0].credentials[0].expiresAt: ",
      ],
      [
        { connections: [connection("org-1", { other: 1 })] },
        "plugins[scim].connections[0].credentials[0].other: ",
      ],
      [
        {
          connections: [
            {
              ...connection("org-1"),
              credentials: [
                { type: "bearer", id: "one", token: TOKEN },
                { type: "bearer", id: "one", token: `${TOKEN}2` },
              ],
            },
          ],
        },
        "plugins[scim].connections[0].credentials[1].id: ",
      ],
      [
        {
          connections: [
            {
              ...connection("org-1"),
              credentials: [
                { type: "bearer", id: "one", token: TOKEN },
                { type: "bearer", id: "two", token: TOKEN },
              ],
            },
          ],
        },
        "plugins[scim].connections[0].credentials[1].token: ",
      ],
      [
        { connections: [{ ...connection("org-1"), id: "a b" }] },
        "plugins[scim].connections[0].id: ",
      ],
      [
        { connections: [{ ...connection("org-1"), other: 1 }] as never },
        "plugins[scim].connections[0].other: ",
      ],
      [
        { connections: [{ ...connection("org-1"), provisioningDomainId: 3 }] as never },
        "plugins[scim].connections[0].provisioningDomainId: ",
      ],
      [{ ...base, compatibility: { other: 1 } as never }, "plugins[scim].compatibility.other: "],
      [
        { ...base, compatibility: { microsoftEntra: { acceptLegacyGroupSchema: "yes" as never } } },
        "plugins[scim].compatibility.microsoftEntra.acceptLegacyGroupSchema: ",
      ],
      [{ ...base, other: 1 } as never, "plugins[scim].other: "],
      [{} as never, "plugins[scim].connections: "],
    ];
    for (const [o, path] of rows) {
      const { refusals } = checkOptions(withScim(o));
      expect(
        refusals.filter((r) => r.startsWith(path)),
        path,
      ).toHaveLength(1);
    }
    const entra = checkOptions(
      withScim({ ...base, compatibility: { microsoftEntra: { acceptLegacyGroupSchema: true } } }),
    );
    expect(entra.refusals).toEqual([]);
    expect(
      entra.notes.some((n) =>
        n.startsWith("plugins[scim].compatibility.microsoftEntra.acceptLegacyGroupSchema: "),
      ),
    ).toBe(true);
    const bare = checkOptions({ ...withScim(base), plugins: [scim(base)] });
    expect(
      bare.refusals.some((r) => r.startsWith("plugins[scim]: needs plugins[organization]")),
    ).toBe(true);
  });
});
