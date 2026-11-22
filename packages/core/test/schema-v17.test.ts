import { describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "../src/config.js";
import { createConnection } from "../src/engine/sso/connections.js";
import { ROUTES } from "../src/http/route-list.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { newId } from "../src/primitives/ids.js";
import { SCHEMA_VERSION, type SsoSetupLinkRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { StorageError } from "../src/storage/port.js";
import { base } from "./every-feature.js";
import { SSO_APP, seedOrganization, ssoAuth } from "./sso/helpers.js";

// Schema version 17 (plan 13a Task 0). The writes and reads of the three
// new models are in the conformance suite, so every adapter runs them.

/** The organizations block of a config that can turn `sso.setup` on. */
const ORGANIZATIONS = { platformRole: "owner", platformOrganization: "platform-co" };
/** One resolver that answers no record: `sso` needs one. No test here asks it. */
const DNS = [{ name: "none", txt: async () => [] }];

/** One setup link row, as the mint of Task 2 writes it. */
function linkRow(now: Date, tokenHash: string): SsoSetupLinkRow {
  return {
    id: newId(now),
    createdAt: now,
    updatedAt: now,
    organizationId: "org_1",
    tokenHash,
    hint: "abcd",
    steps: ["domain", "connection"],
    kinds: ["oidc"],
    note: "Pat at Acme IT",
    createdBy: "sso-test",
    expiresAt: new Date(now.getTime() + 72 * 3600_000),
    revokedAt: null,
    endedAt: null,
    openedAt: null,
    readyAt: null,
  };
}

describe("schema version 17 (plan 13a)", () => {
  it("version: is schema version 17", () => {
    expect(SCHEMA_VERSION).toBe(17);
  });

  it("draft default: a connection insert with no draft reads back as live, version 1", async () => {
    const w = ssoAuth({ sso: { oidc: true } });
    const organizationId = await seedOrganization(w);
    const made = await createConnection(w.config, SSO_APP, {
      organizationId,
      kind: "oidc",
      label: "Acme Entra ID",
      issuer: "https://login.idp.example/acme/v2.0",
      clientId: "acme-client",
      clientSecret: "the-client-secret-of-acme-0123456789",
    });
    if (!made.ok) throw new Error(made.code);
    const row = await w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: made.value.id },
    ]);
    expect([row?.draft, row?.version, row?.setupLinkId]).toEqual([false, 1, null]);
  });

  it("link token unique: a second link with the same hash throws a unique error", async () => {
    const storage = createMemoryAdapter();
    const now = new Date("2026-11-23T10:00:00Z");
    await storage.create("ssoSetupLink", linkRow(now, "hash-1"));
    const second = storage.create("ssoSetupLink", linkRow(new Date(now.getTime() + 1), "hash-1"));
    await expect(second).rejects.toBeInstanceOf(StorageError);
    await expect(second).rejects.toMatchObject({
      code: "unique_violation",
      fields: ["tokenHash"],
    });
  });

  it("config off: with no sso.setup, setup is off and no setup route is served", () => {
    const config = resolveConfig({
      ...base,
      organizations: ORGANIZATIONS,
      sso: { dns: DNS },
    });
    expect(config.sso?.setup).toBe(false);
    const setupKeys = ROUTES.filter((r) => r.feature === "ssoSetup").map(
      (r) => `${r.method} ${r.path}`,
    );
    expect(setupKeys).toHaveLength(13);
    const served = coreRoutes(config).map((r) => `${r.method} ${r.path}`);
    expect(served.filter((k) => setupKeys.includes(k))).toEqual([]);
  });

  it("config needs organizations: sso.setup with no organizations throws a ConfigError", () => {
    const make = () => resolveConfig({ ...base, sso: { dns: DNS, setup: {} } });
    expect(make).toThrow(ConfigError);
    expect(make).toThrow(/organizations/);
  });

  it.each([0, 169])("ttl range: ttlHours %i throws a ConfigError", (ttlHours) => {
    const make = () =>
      resolveConfig({
        ...base,
        organizations: ORGANIZATIONS,
        sso: { dns: DNS, setup: { ttlHours } },
      });
    expect(make).toThrow(ConfigError);
    expect(make).toThrow(/sso\.setup\.ttlHours/);
  });

  it("ttl range: ttlHours 1 and 168 resolve, and the default is 72", () => {
    const resolve = (setup: { ttlHours?: number }) =>
      resolveConfig({ ...base, organizations: ORGANIZATIONS, sso: { dns: DNS, setup } }).sso?.setup;
    expect(resolve({ ttlHours: 1 })).toEqual({ ttlHours: 1, page: null });
    expect(resolve({ ttlHours: 168 })).toEqual({ ttlHours: 168, page: null });
    expect(resolve({})).toEqual({ ttlHours: 72, page: null });
  });

  it("config needs notices: sso.setup with account.notices false throws a ConfigError", () => {
    const make = () =>
      resolveConfig({
        ...base,
        organizations: ORGANIZATIONS,
        account: { notices: false },
        sso: { dns: DNS, setup: {} },
      });
    expect(make).toThrow(ConfigError);
    expect(make).toThrow(/account\.notices/);
  });

  it("refuses a page that is not a function", () => {
    const make = () =>
      resolveConfig({
        ...base,
        organizations: ORGANIZATIONS,
        // @ts-expect-error a config in JavaScript can carry any value
        sso: { dns: DNS, setup: { page: "<html>" } },
      });
    expect(make).toThrow(/sso\.setup\.page must be a function/);
  });
});
