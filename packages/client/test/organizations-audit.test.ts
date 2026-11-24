import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createClient,
  type OrganizationAuditQuery,
  type OrganizationAuditView,
} from "../src/client.js";

const BASE = "https://api.example.com";
const FROM = "2026-11-01T00:00:00.000Z";
const TO = "2026-11-23T00:00:00.000Z";

/** One audit row with the id `a<n>`, zero-padded, so the ids sort in row order. */
function row(n: number): OrganizationAuditView {
  return {
    id: `a${String(n).padStart(4, "0")}`,
    at: "2026-11-23T10:00:00.000Z",
    actor: { kind: "member", id: "u1", email: "ada@example.com" },
    action: "organization_member_add",
    targetUserId: "u2",
    data: null,
    ip: "192.0.2.1",
    userAgent: "Mozilla/5.0",
  };
}

/** The rows from `first` to `last`, both included. */
function rows(first: number, last: number): OrganizationAuditView[] {
  return Array.from({ length: last - first + 1 }, (_, i) => row(first + i));
}

/**
 * A fetch that answers one page for each expected query, in order, and keeps
 * each URL. A query out of order answers `invalid_body`, so a wrong cursor
 * ends the iteration with a throw, never with a loop.
 */
function pages(answers: { query: string; status: number; body: unknown }[]) {
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    urls.push(`${req.method} ${req.url}`);
    const next = answers[urls.length - 1];
    if (!next || req.url !== `${BASE}/auth/organizations/audit?${next.query}`)
      return Response.json({ error: "invalid_body" }, { status: 400 });
    return Response.json(next.body, { status: next.status });
  }) as typeof globalThis.fetch;
  return { urls, client: createClient({ baseURL: BASE, fetch }) };
}

/** The three pages of 100, 100, and 7 rows. `next` is the id of the last row of a page. */
const THREE_PAGES = [
  {
    query: "organizationId=o1&limit=100",
    status: 200,
    body: { rows: rows(1, 100), next: "a0100" },
  },
  {
    query: "organizationId=o1&limit=100&after=a0100",
    status: 200,
    body: { rows: rows(101, 200), next: "a0200" },
  },
  {
    query: "organizationId=o1&limit=100&after=a0200",
    status: 200,
    body: { rows: rows(201, 207), next: null },
  },
];

describe("the organization audit through the client (plan 13b)", () => {
  it("lists one page with one GET of the query, and answers typed rows", async () => {
    const { urls, client } = pages([
      { query: "organizationId=o1", status: 200, body: { rows: rows(1, 2), next: null } },
    ]);
    const r = await client.organizations.audit.list({ organizationId: "o1" });
    expect(urls).toEqual([`GET ${BASE}/auth/organizations/audit?organizationId=o1`]);
    expect(r).toEqual({ ok: true, value: { rows: rows(1, 2), next: null } });
    if (!r.ok) return;
    expectTypeOf(r.value.rows).toEqualTypeOf<OrganizationAuditView[]>();
    expectTypeOf(r.value.next).toEqualTypeOf<string | null>();
  });

  it("exports every row of three pages in order with three requests", async () => {
    const { urls, client } = pages(THREE_PAGES);
    const seen: string[] = [];
    for await (const r of client.organizations.audit.export({ organizationId: "o1" }))
      seen.push(r.id);
    expect(seen).toEqual(rows(1, 207).map((r) => r.id));
    expect(urls).toEqual(THREE_PAGES.map((p) => `GET ${BASE}/auth/organizations/audit?${p.query}`));
  });

  it("yields the rows of page 1, then throws the failure of page 2", async () => {
    const [first, second] = THREE_PAGES;
    if (!first || !second) throw new Error("no page");
    const { urls, client } = pages([
      first,
      { query: second.query, status: 429, body: { error: "rate_limited" } },
    ]);
    const seen: string[] = [];
    const run = async () => {
      for await (const r of client.organizations.audit.export({ organizationId: "o1" }))
        seen.push(r.id);
    };
    await expect(run()).rejects.toEqual({ ok: false, code: "rate_limited", status: 429 });
    expect(seen).toEqual(rows(1, 100).map((r) => r.id));
    expect(urls).toHaveLength(2);
  });

  it("sends one request only when the caller breaks after 10 rows", async () => {
    const { urls, client } = pages(THREE_PAGES);
    const seen: string[] = [];
    for await (const r of client.organizations.audit.export({ organizationId: "o1" })) {
      seen.push(r.id);
      if (seen.length === 10) break;
    }
    expect(seen).toEqual(rows(1, 10).map((r) => r.id));
    expect(urls).toHaveLength(1);
  });

  // Fix round 1 (I1): each filter that `list` sends, alone, with the exact query.
  it.each<{ filter: string; input: OrganizationAuditQuery; query: string }>([
    {
      filter: "limit",
      input: { organizationId: "o1", limit: 5 },
      query: "organizationId=o1&limit=5",
    },
    {
      filter: "action",
      input: { organizationId: "o1", action: "organization_member_add" },
      query: "organizationId=o1&action=organization_member_add",
    },
    {
      filter: "from",
      input: { organizationId: "o1", from: FROM },
      query: `organizationId=o1&from=${encodeURIComponent(FROM)}`,
    },
    {
      filter: "to",
      input: { organizationId: "o1", to: TO },
      query: `organizationId=o1&to=${encodeURIComponent(TO)}`,
    },
  ])("lists with the filter $filter in the query", async ({ input, query }) => {
    const { urls, client } = pages([{ query, status: 200, body: { rows: [], next: null } }]);
    const r = await client.organizations.audit.list(input);
    expect(urls).toEqual([`GET ${BASE}/auth/organizations/audit?${query}`]);
    expect(r).toEqual({ ok: true, value: { rows: [], next: null } });
  });

  it("exports with the filters action, from, and to on each page", async () => {
    const filters = `&action=organization_member_add&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
    const filtered = THREE_PAGES.map((p) => ({ ...p, query: `${p.query}${filters}` }));
    const { urls, client } = pages(filtered);
    const seen: string[] = [];
    const query = {
      organizationId: "o1",
      action: "organization_member_add",
      from: FROM,
      to: TO,
    } as const;
    for await (const r of client.organizations.audit.export(query)) seen.push(r.id);
    expect(seen).toHaveLength(207);
    expect(urls).toEqual(filtered.map((p) => `GET ${BASE}/auth/organizations/audit?${p.query}`));
  });

  // Fix round 1 (M2): a 200 that is not a page is `unexpected` with status 200 (the plan 11d rule).
  it("answers unexpected for a 200 whose rows are not a list", async () => {
    const { client } = pages([
      { query: "organizationId=o1", status: 200, body: { rows: "a0001", next: null } },
    ]);
    const r = await client.organizations.audit.list({ organizationId: "o1" });
    expect(r).toEqual({ ok: false, code: "unexpected", status: 200 });
  });

  it("throws unexpected, with no row, when page 1 has no rows", async () => {
    const [first] = THREE_PAGES;
    if (!first) throw new Error("no page");
    const { client } = pages([{ query: first.query, status: 200, body: { next: null } }]);
    const seen: string[] = [];
    const run = async () => {
      for await (const r of client.organizations.audit.export({ organizationId: "o1" }))
        seen.push(r.id);
    };
    await expect(run()).rejects.toEqual({ ok: false, code: "unexpected", status: 200 });
    expect(seen).toEqual([]);
  });

  it("yields the rows of page 1, then throws unexpected when page 2 has no next", async () => {
    const [first, second] = THREE_PAGES;
    if (!first || !second) throw new Error("no page");
    const { urls, client } = pages([
      first,
      { query: second.query, status: 200, body: { rows: rows(101, 200) } },
    ]);
    const seen: string[] = [];
    const run = async () => {
      for await (const r of client.organizations.audit.export({ organizationId: "o1" }))
        seen.push(r.id);
    };
    await expect(run()).rejects.toEqual({ ok: false, code: "unexpected", status: 200 });
    expect(seen).toEqual(rows(1, 100).map((r) => r.id));
    expect(urls).toHaveLength(2);
  });
});
