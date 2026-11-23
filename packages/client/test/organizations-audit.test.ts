import { describe, expect, expectTypeOf, it } from "vitest";
import { createClient, type OrganizationAuditView } from "../src/client.js";

const BASE = "https://api.example.com";

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
});
