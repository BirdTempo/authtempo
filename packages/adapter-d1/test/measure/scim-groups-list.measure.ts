import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { acme, call, count, GROUP_URN, make, resetWorld } from "../scim-groups-world.js";

// A named measure, out of the default test gate (fix wave of plan 12i, item
// 3). It writes 10003 member rows and reads two list pages of the SCIM
// Groups on the D1 binding. Its time limit is 120 s, and it failed the plan
// 12d evidence runs at load 38 to 48 by that limit.
// Run it by name: `pnpm turbo run measure --filter=@authtempo/adapter-d1 --force`
// (vitest.measure.config.ts). It needs no test server.

/** Two list pages with members, each of whole groups, at most 10000 member rows. */
const MEASURED_LIST = { first: 6, next: 6 };

beforeEach(resetWorld);

describe("the SCIM Groups list on D1 at 10000 member rows (plan 12d Task 11, a named measure)", () => {
  it("ends a list page with members at 10000 member rows, inside 50 queries", async () => {
    const setup = make(env.DB, false);
    const { organizationId, token } = await acme(setup);
    const groups: string[] = [];
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      const r = await call(token, "POST", "/Groups", { schemas: [GROUP_URN], displayName: name });
      expect(r.status).toBe(201);
      groups.push(String(r.body.id));
    }
    const [alpha, beta, gamma] = groups;
    // 5001 Users in Alpha and in Beta, and one of them in Gamma: 10003 member rows. SQL
    // writes the rows that 556 PATCH requests of 9 members each would write.
    const now = Date.now();
    const n = "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)";
    const su = "'su-' || printf('%05d', i)";
    await env.DB.batch([
      env.DB.prepare(
        `${n} INSERT INTO ta_user (id, created_at, updated_at, email, email_verified) SELECT 'mu-' || i, ?1, ?1, 'm' || i || '@acme.example', 1 FROM n`,
      ).bind(now),
      env.DB.prepare(
        `${n} INSERT INTO ta_member (id, created_at, updated_at, organization_id, user_id, role) SELECT 'mb-' || i, ?1, ?1, ?2, 'mu-' || i, 'member' FROM n`,
      ).bind(now, organizationId),
      env.DB.prepare(
        `${n} INSERT INTO ta_scim_user (id, created_at, updated_at, organization_id, user_id, user_name, user_name_key, active, data, version) SELECT ${su}, ?1, ?1, ?2, 'mu-' || i, 'm' || i || '@acme.example', 'm' || i || '@acme.example', 1, '{}', 1 FROM n`,
      ).bind(now, organizationId),
      ...[alpha, beta].map((g) =>
        env.DB.prepare(
          `${n} INSERT INTO ta_scim_group_member (id, created_at, updated_at, group_id, scim_user_id) SELECT 'gm-' || ?2 || '-' || i, ?1, ?1, ?2, ${su} FROM n`,
        ).bind(now, g ?? ""),
      ),
      env.DB.prepare(
        "INSERT INTO ta_scim_group_member (id, created_at, updated_at, group_id, scim_user_id) VALUES ('gm-gamma', ?1, ?1, ?2, 'su-00000')",
      ).bind(now, gamma ?? ""),
    ]);
    expect(await count("SELECT count(*) AS n FROM ta_scim_group_member")).toBe(10003);
    const page = async (start: number) => {
      const r = await call(token, "GET", `/Groups?startIndex=${start}&count=100`, undefined, true);
      const list = r.body.Resources as { id: string; members?: unknown[] }[];
      return {
        total: r.body.totalResults,
        groups: list.map((g) => [g.id, g.members?.length ?? 0]),
        items: Number(r.body.itemsPerPage),
        queries: r.queries,
      };
    };
    // By id, each page holds whole groups, at most 10000 member rows.
    const order = [...groups].sort().map((id) => [id, id === gamma ? 1 : 5001] as const);
    const fits = (from: number) => {
      const out: (readonly [string, number])[] = [];
      let rows = 0;
      for (const g of order.slice(from)) {
        if (out.length > 0 && rows + g[1] > 10000) break;
        out.push(g);
        rows += g[1];
      }
      return out;
    };
    const first = await page(1);
    expect(first).toMatchObject({ total: 3, groups: fits(0), items: fits(0).length });
    expect(first.items).toBeLessThan(3);
    const next = await page(first.items + 1);
    expect(next).toMatchObject({ total: 3, groups: fits(first.items) });
    const counts = { first: first.queries, next: next.queries };
    expect(counts).toEqual(MEASURED_LIST);
    for (const q of Object.values(counts)) expect(q).toBeLessThanOrEqual(50);
  }, 120_000);
});
