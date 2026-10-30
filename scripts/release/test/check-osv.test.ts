import { describe, expect, it } from "vitest";
import type { ClosurePackage } from "../src/check-dependencies.ts";
import { checkOsv, OSV_BATCH_URL, type OsvExemption, type OsvQuery } from "../src/check-osv.ts";
import { summaryLine } from "../src/lib/report.ts";

const CLOSURE = [
  { name: "jose", version: "6.2.12" },
  { name: "lodash", version: "4.17.20" },
];

/**
 * The answer of OSV to CLOSURE, with one advisory of the five that OSV gave for
 * lodash 4.17.20 (POST /v1/querybatch, read 2026-10-20 21:59 CST).
 */
const ONE_ADVISORY = {
  results: [
    {},
    { vulns: [{ id: "GHSA-35jh-r3h4-6jhm", modified: "2026-10-17T02:55:38.085813Z" }] },
  ],
};

interface Call {
  url: string;
  method: string | undefined;
  body: unknown;
}

/** A fake query that records each call and answers each batch from `answer`. */
function fake(answer: (queries: unknown[]) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const query: OsvQuery = async (url, init) => {
    const body = JSON.parse(init.body) as { queries: unknown[] };
    calls.push({ url, method: init.method, body });
    const a = answer(body.queries);
    return { status: a.status, json: async () => a.body };
  };
  return { calls, query };
}

const answering = (body: unknown) => fake(() => ({ status: 200, body }));
const noAdvisory = () =>
  fake((queries) => ({ status: 200, body: { results: queries.map(() => ({})) } }));

const EXEMPTION: OsvExemption = {
  id: "GHSA-35jh-r3h4-6jhm",
  name: "lodash",
  version: "4.17.20",
  reason: "The released code never calls the template function.",
  read: "2026-10-20",
  expires: "2026-12-31",
};

describe("check-osv", () => {
  it("passes when OSV answers no advisory", async () => {
    const { calls, query } = noAdvisory();
    const r = await checkOsv({ closure: CLOSURE, exempt: [], query, today: "2026-10-20" });
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe("check-osv: PASS packages=2 advisories=0 exempt=0 failures=0");
    expect(calls.map((c) => [c.url, c.method])).toEqual([
      ["https://api.osv.dev/v1/querybatch", "POST"],
    ]);
    expect(OSV_BATCH_URL).toBe("https://api.osv.dev/v1/querybatch");
  });

  it("fails an open advisory with no exemption", async () => {
    const { query } = answering(ONE_ADVISORY);
    const r = await checkOsv({ closure: CLOSURE, exempt: [], query, today: "2026-10-20" });
    expect(r.failures).toEqual([
      "GHSA-35jh-r3h4-6jhm: an open advisory for lodash@4.17.20 with no live exemption",
    ]);
    expect(summaryLine(r)).toBe("check-osv: FAIL packages=2 advisories=1 exempt=0 failures=1");
  });

  it("fails a package whose advisories need a second page", async () => {
    const { query } = answering({
      results: [{}, { ...ONE_ADVISORY.results[1], next_page_token: "token" }],
    });
    const r = await checkOsv({ closure: CLOSURE, exempt: [EXEMPTION], query, today: "2026-10-20" });
    expect(r.failures).toEqual([
      "lodash@4.17.20: OSV holds more advisories than one page; read them at osv.dev",
    ]);
  });

  it("passes an advisory with a live exemption, and counts it", async () => {
    const { query } = answering(ONE_ADVISORY);
    const r = await checkOsv({ closure: CLOSURE, exempt: [EXEMPTION], query, today: "2026-10-20" });
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe("check-osv: PASS packages=2 advisories=1 exempt=1 failures=0");
  });

  it("fails an exemption past its expiry, or with an expiry more than 90 days after its read date", async () => {
    const { query } = answering(ONE_ADVISORY);
    const expired = await checkOsv({
      closure: CLOSURE,
      // A read date after the expiry fails first, so this read date comes before it.
      exempt: [{ ...EXEMPTION, read: "2026-10-01", expires: "2026-10-19" }],
      query,
      today: "2026-10-20",
    });
    expect(expired.failures).toEqual([
      "GHSA-35jh-r3h4-6jhm: the exemption for lodash@4.17.20 expired on 2026-10-19",
      "GHSA-35jh-r3h4-6jhm: an open advisory for lodash@4.17.20 with no live exemption",
    ]);
    // 2026-10-20 plus 90 days is 2027-01-18: that day is the last good expiry.
    const lastDay = await checkOsv({
      closure: CLOSURE,
      exempt: [{ ...EXEMPTION, expires: "2027-01-18" }],
      query,
      today: "2026-10-20",
    });
    expect(lastDay.failures).toEqual([]);
    const long = await checkOsv({
      closure: CLOSURE,
      exempt: [{ ...EXEMPTION, expires: "2027-01-19" }],
      query,
      today: "2026-10-20",
    });
    expect(long.failures).toEqual([
      "GHSA-35jh-r3h4-6jhm: the exemption for lodash@4.17.20 expires on 2027-01-19, more than 90 days after its read date 2026-10-20",
      "GHSA-35jh-r3h4-6jhm: an open advisory for lodash@4.17.20 with no live exemption",
    ]);
  });

  it("fails an exemption whose read date is after today or after its expiry", async () => {
    const { query } = answering(ONE_ADVISORY);
    // The two cases of the Task 7 review, on 2026-10-21: each one passed before ruling 33.
    const future = await checkOsv({
      closure: CLOSURE,
      exempt: [
        { ...EXEMPTION, read: "2027-06-01", expires: "2027-08-15" },
        { ...EXEMPTION, read: "2099-01-01", expires: "2026-12-31" },
      ],
      query,
      today: "2026-10-21",
    });
    expect(future.failures).toEqual([
      "GHSA-35jh-r3h4-6jhm: the exemption for lodash@4.17.20 has the read date 2027-06-01, after today 2026-10-21",
      "GHSA-35jh-r3h4-6jhm: the exemption for lodash@4.17.20 has the read date 2099-01-01, after today 2026-10-21",
      "GHSA-35jh-r3h4-6jhm: an open advisory for lodash@4.17.20 with no live exemption",
    ]);
    const reversed = await checkOsv({
      closure: CLOSURE,
      exempt: [{ ...EXEMPTION, read: "2026-10-21", expires: "2026-10-20" }],
      query,
      today: "2026-10-21",
    });
    expect(reversed.failures).toEqual([
      "GHSA-35jh-r3h4-6jhm: the exemption for lodash@4.17.20 has the read date 2026-10-21, after its expiry 2026-10-20",
      "GHSA-35jh-r3h4-6jhm: an open advisory for lodash@4.17.20 with no live exemption",
    ]);
  });

  it("fails an exemption that matches no package of the closure as stale", async () => {
    const { query } = noAdvisory();
    const r = await checkOsv({
      closure: CLOSURE,
      exempt: [{ ...EXEMPTION, name: "left-pad", version: "1.3.0" }],
      query,
      today: "2026-10-20",
    });
    expect(r.failures).toEqual([
      "GHSA-35jh-r3h4-6jhm: the exemption for left-pad@1.3.0 matches no package of the runtime closure, so it is stale",
    ]);
  });

  it("fails an exemption of an advisory that OSV did not return for its package (ruling 64 of plan 12j, Minor 3)", async () => {
    // OSV returns no advisory for lodash 4.17.20, as after a fix of the record.
    const none = await checkOsv({
      closure: CLOSURE,
      exempt: [EXEMPTION],
      query: noAdvisory().query,
      today: "2026-10-20",
    });
    expect(none.failures).toEqual([
      "GHSA-35jh-r3h4-6jhm: the exemption for lodash@4.17.20 names an advisory that OSV did not return for that package and version, so it is stale",
    ]);
    // A wrong id: OSV returns GHSA-35jh-r3h4-6jhm, and the exemption names another one.
    const wrong = await checkOsv({
      closure: CLOSURE,
      exempt: [{ ...EXEMPTION, id: "GHSA-0000-0000-0000" }],
      query: answering(ONE_ADVISORY).query,
      today: "2026-10-20",
    });
    expect(wrong.failures).toEqual([
      "GHSA-35jh-r3h4-6jhm: an open advisory for lodash@4.17.20 with no live exemption",
      "GHSA-0000-0000-0000: the exemption for lodash@4.17.20 names an advisory that OSV did not return for that package and version, so it is stale",
    ]);
  });

  it("notes a URL other than the OSV batch query", async () => {
    const { calls, query } = noAdvisory();
    const r = await checkOsv({
      closure: CLOSURE,
      exempt: [],
      query,
      today: "2026-10-20",
      url: "http://127.0.0.1:1/v1/querybatch",
    });
    expect(r.failures).toEqual([]);
    expect(r.notes).toEqual([
      "OSV_URL is http://127.0.0.1:1/v1/querybatch, not https://api.osv.dev/v1/querybatch: this run did not ask OSV",
    ]);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:1/v1/querybatch"]);
    const same = await checkOsv({
      closure: CLOSURE,
      exempt: [],
      query,
      today: "2026-10-20",
      url: "https://api.osv.dev/v1/querybatch",
    });
    expect(same.notes).toEqual([]);
  });

  it("fails an exemption with no reason", async () => {
    const { query } = answering(ONE_ADVISORY);
    const r = await checkOsv({
      closure: CLOSURE,
      exempt: [{ ...EXEMPTION, reason: "" }],
      query,
      today: "2026-10-20",
    });
    expect(r.failures).toEqual([
      "GHSA-35jh-r3h4-6jhm: the exemption for lodash@4.17.20 has no reason",
      "GHSA-35jh-r3h4-6jhm: an open advisory for lodash@4.17.20 with no live exemption",
    ]);
  });

  it("fails when OSV gives no answer", async () => {
    const rejects: OsvQuery = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    };
    const refused = await checkOsv({
      closure: CLOSURE,
      exempt: [],
      query: rejects,
      today: "2026-10-20",
    });
    expect(refused.failures).toEqual([
      "no answer from OSV is not a pass: connect ECONNREFUSED 127.0.0.1:9",
    ]);
    expect(summaryLine(refused)).toMatch(/^check-osv: FAIL /);

    const busy = fake(() => ({ status: 503, body: {} }));
    const unavailable = await checkOsv({
      closure: CLOSURE,
      exempt: [],
      query: busy.query,
      today: "2026-10-20",
    });
    expect(unavailable.failures).toEqual(["no answer from OSV is not a pass: status 503"]);

    const short = answering({ results: [{}] });
    const partial = await checkOsv({
      closure: CLOSURE,
      exempt: [],
      query: short.query,
      today: "2026-10-20",
    });
    expect(partial.failures).toEqual(["no answer from OSV is not a pass: 1 results for 2 queries"]);

    const hangs: OsvQuery = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const late = await checkOsv({
      closure: CLOSURE,
      exempt: [],
      query: hangs,
      today: "2026-10-20",
      timeoutMs: 20,
    });
    expect(late.failures).toEqual(["no answer from OSV is not a pass: no answer in 20 ms"]);
  });

  it("fails when it reads zero packages", async () => {
    const { calls, query } = noAdvisory();
    const r = await checkOsv({ closure: [], exempt: [], query, today: "2026-10-20" });
    expect(r.failures).toEqual(["read 0 packages"]);
    expect(calls).toEqual([]);
  });

  it("sends one query per 1000 packages", async () => {
    const { calls, query } = noAdvisory();
    const closure = Array.from({ length: 1001 }, (_, i) => ({ name: `p${i}`, version: "1.0.0" }));
    const r = await checkOsv({ closure, exempt: [], query, today: "2026-10-20" });
    expect(r.failures).toEqual([]);
    expect(calls.map((c) => (c.body as { queries: unknown[] }).queries.length)).toEqual([1000, 1]);
  });

  it("sends only names and versions", async () => {
    const { calls, query } = noAdvisory();
    // The entry passes the closure of check-dependencies, which also holds the license.
    const jose: ClosurePackage = {
      name: "jose",
      version: "6.2.12",
      license: "MIT",
      from: "@authtempo/core",
    };
    await checkOsv({
      closure: [jose],
      exempt: [],
      query,
      today: "2026-10-20",
    });
    expect(calls.map((c) => c.body)).toEqual([
      { queries: [{ package: { name: "jose", ecosystem: "npm" }, version: "6.2.12" }] },
    ]);
  });
});
