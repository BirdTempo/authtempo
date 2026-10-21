import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkPerformance,
  MEASURED_END,
  MEASURED_START,
  PERFORMANCE_DATA,
  PERFORMANCE_PAGE,
  type PerformanceData,
  renderPerformanceTable,
} from "../scripts/check-performance.ts";
import { docsPages } from "../scripts/lib/load.ts";
import { SITE } from "../scripts/lib/paths.ts";

/** A record as measure-performance.ts writes it, with five operations of 200 samples. */
function fixture(): PerformanceData {
  const op = (route: string) => ({
    route,
    samples: 200,
    serverMs: { p50: 1, p95: 3, max: 9 },
    clientMs: { p50: 1.5, p95: 3.5, max: 12.25 },
  });
  return {
    measuredAt: "2026-10-22T02:00:00.000Z",
    commit: "0123456789abcdef0123456789abcdef01234567",
    machine: { os: "Darwin", release: "27.0.0", cpu: "A CPU", cores: 8, memoryGiB: 16 },
    load: { before: [1.5, 2, 2.5], after: [2, 2, 2.5] },
    runtime: { wrangler: "4.148.0", workerd: "local", node: "26.10.0" },
    storage: "d1-local",
    pbkdf2Iterations: 100000,
    warmup: 20,
    operations: [
      op("POST /password/sign-in"),
      op("GET /session"),
      op("GET /token"),
      op("GET /jwks"),
      op("POST /magic-link/request"),
    ],
  };
}

/** A page with the block of the record and the sentence under it. */
function page(data: PerformanceData): string {
  return `# Performance\n\n${MEASURED_START}\n${renderPerformanceTable(data)}\n${MEASURED_END}\n\nLocal workerd is not a deployed Worker. More text.\n`;
}

describe("checkPerformance", () => {
  it("passes on the real page and the real data", () => {
    const data = JSON.parse(readFileSync(`${SITE}${PERFORMANCE_DATA}`, "utf8")) as PerformanceData;
    const real = docsPages().find((p) => p.path === PERFORMANCE_PAGE)?.source ?? "";
    const r = checkPerformance(real, data, data.machine.cores);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ operations: 5, samples: 1000 });
  });

  it("passes on a record and its page", () => {
    const data = fixture();
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ operations: 5, samples: 1000 });
  });

  it("fails on a missing condition", () => {
    const data = fixture();
    const { before: _before, ...rest } = data.load;
    const broken = { ...data, load: rest } as unknown as PerformanceData;
    const r = checkPerformance(page(data), broken, 8);
    expect(r.failures).toEqual(["the condition load.before is missing or not three load averages"]);
  });

  it("fails on an empty text condition and a count that is not a positive integer", () => {
    const data = fixture();
    data.machine.cpu = " ";
    data.warmup = 0;
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual([
      "the condition machine.cpu is missing or empty",
      "the condition warmup is missing or not a positive integer",
    ]);
  });

  it("fails when the page table differs from the data", () => {
    const data = fixture();
    const edited = page(data).replace("| 3.0 |", "| 2.0 |");
    expect(edited).not.toBe(page(data));
    const r = checkPerformance(edited, data, 8);
    expect(r.failures).toEqual(["the block of the page differs from renderPerformanceTable(data)"]);
  });

  it("fails on a load above the core count", () => {
    const data = fixture();
    data.load.before = [9, 2, 2.5];
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual(["the load before the run is 9, above the 8 cores"]);
  });

  it("fails on fewer than 100 samples", () => {
    const data = fixture();
    const first = data.operations[0];
    if (first) first.samples = 99;
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual([
      "POST /password/sign-in: 99 samples; an operation needs at least 100",
    ]);
  });

  it("fails on a commit that is not 40 hex characters", () => {
    const data = fixture();
    data.commit = "0123456789abcdef";
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual(["the commit 0123456789abcdef is not 40 hex characters"]);
  });

  it("fails when the first sentence under the table is not the local workerd sentence", () => {
    const data = fixture();
    const moved = page(data).replace(
      "Local workerd is not a deployed Worker. More text.",
      "More text. Local workerd is not a deployed Worker.",
    );
    const r = checkPerformance(moved, data, 8);
    expect(r.failures).toEqual([
      'the first sentence under the table does not start with "Local workerd is not a deployed Worker"',
    ]);
  });

  it("fails on a spread that is not p50 <= p95 <= max", () => {
    const data = fixture();
    const first = data.operations[0];
    if (first) first.serverMs = { p50: 4, p95: 3, max: 9 };
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual(["POST /password/sign-in: serverMs is not p50 <= p95 <= max"]);
  });

  it("fails on a record with no operations", () => {
    const { operations: _operations, ...rest } = fixture();
    const broken = rest as unknown as PerformanceData;
    const r = checkPerformance(page(fixture()), broken, 8);
    expect(r.failures).toEqual([
      "the record has no operations",
      "the record has no operation POST /password/sign-in",
      "the record has no operation GET /session",
      "the record has no operation GET /token",
      "the record has no operation GET /jwks",
      "the record has no operation POST /magic-link/request",
      "read 0 operations",
      "read 0 samples",
    ]);
  });

  it("fails on a record with no row for one route", () => {
    const data = fixture();
    data.operations = data.operations.filter((o) => o.route !== "GET /jwks");
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual(["the record has no operation GET /jwks"]);
  });

  it("fails on a route that is not one of the measured routes", () => {
    const data = fixture();
    const last = data.operations[4];
    if (last) last.route = "POST /magic-link/verify";
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual([
      "the record has no operation POST /magic-link/request",
      "the operation POST /magic-link/verify is not one of the measured routes",
    ]);
  });

  it("fails on two rows of one route", () => {
    const data = fixture();
    const first = data.operations[0];
    if (first) data.operations.push({ ...first });
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual(["the record has the operation POST /password/sign-in 2 times"]);
  });

  it("fails on a date that is not an ISO time", () => {
    const data = fixture();
    data.measuredAt = "2026-10-22 02:00";
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual(["the date 2026-10-22 02:00 is not an ISO time"]);
  });

  it("fails on a date of the ISO form that is not a real time", () => {
    const data = fixture();
    data.measuredAt = "2026-02-30T02:00:00.000Z";
    const r = checkPerformance(page(data), data, 8);
    expect(r.failures).toEqual(["the date 2026-02-30T02:00:00.000Z is not an ISO time"]);
  });

  it("fails on a runtime or a storage that is not local", () => {
    const data = fixture();
    const broken = {
      ...data,
      runtime: { ...data.runtime, workerd: "remote" },
      storage: "d1-remote",
    } as unknown as PerformanceData;
    const r = checkPerformance(page(broken), broken, 8);
    expect(r.failures).toEqual([
      "the condition runtime.workerd is remote, not local",
      "the condition storage is d1-remote, not d1-local",
    ]);
  });
});
