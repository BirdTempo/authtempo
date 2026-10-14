import { describe, expect, it } from "vitest";

/**
 * The error-shape conformance suite of the SDKs (plan 11d, spec 20), as
 * `@authtempo/core/conformance` is for the storage adapters. Each SDK runs
 * the same six faults and must answer one shape: `{ ok: false, code,
 * status }`, plus `message` on `hook_refused` only. A core route family and an
 * OAuth route family differ only where the tables differ.
 */

export type ErrorFamily = "core" | "oauth";

export interface ErrorShapeCase {
  name: string;
  /** The answer of the fake fetch to every request, or "reject" for a fetch that rejects. */
  answer: { status: number; body: string } | "reject";
  expect: Record<ErrorFamily, { code: string; status: number; message?: string }>;
}

const both = (code: string, status: number) => ({
  core: { code, status },
  oauth: { code, status },
});

export const ERROR_SHAPE_CASES: readonly ErrorShapeCase[] = [
  { name: "a fetch that rejects", answer: "reject", expect: both("network", 0) },
  {
    name: "a body that is not JSON",
    answer: { status: 502, body: "<html>bad gateway</html>" },
    expect: both("unexpected", 502),
  },
  {
    name: "a code of both tables",
    answer: { status: 429, body: '{"error":"rate_limited"}' },
    expect: both("rate_limited", 429),
  },
  {
    name: "a code of no table",
    answer: { status: 400, body: '{"error":"brand_new_code"}' },
    expect: both("unexpected", 400),
  },
  {
    name: "hook_refused with a message",
    answer: {
      status: 403,
      body: '{"error":"hook_refused","message":"Choose another name."}',
    },
    expect: {
      core: { code: "hook_refused", status: 403, message: "Choose another name." },
      // hook_refused is not an OAuth code: an OAuth client reads it as unexpected, with no message.
      oauth: { code: "unexpected", status: 403 },
    },
  },
  {
    // A proxy that adds a message to another code: the message is dropped (plan 9d, parked Minor 2).
    name: "a message on another code",
    answer: { status: 404, body: '{"error":"not_found","message":"from a proxy"}' },
    expect: {
      core: { code: "not_found", status: 404 },
      oauth: { code: "unexpected", status: 404 },
    },
  },
];

/** A fetch that answers the case to every request. */
export function caseFetch(c: ErrorShapeCase): typeof fetch {
  return (async () => {
    if (c.answer === "reject") throw new TypeError("Failed to fetch");
    return new Response(c.answer.body, {
      status: c.answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** The SDKs whose suite ran every case in this process, in order. */
export const SDKS_RUN: string[] = [];

/**
 * Runs the six cases for one SDK. `run` makes one call of the SDK with the
 * fetch it is given and answers the failure that the SDK answered.
 */
export function runErrorShapeSuite(
  sdk: string,
  family: ErrorFamily,
  run: (fetch: typeof globalThis.fetch) => Promise<unknown>,
): void {
  describe(`the error shape of ${sdk}`, () => {
    for (const c of ERROR_SHAPE_CASES)
      it(`answers ${c.name} in the one shape`, async () => {
        expect(await run(caseFetch(c))).toEqual({ ok: false, ...c.expect[family] });
      });
    it("ran every case", () => {
      SDKS_RUN.push(sdk);
    });
  });
}
