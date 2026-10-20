import { afterAll, expect, it } from "vitest";
import { assertFreshBuild } from "./support/bin.js";
import {
  type ExampleWorker,
  ownerOf,
  START_LIMIT_MS,
  startExampleWorker,
} from "./support/example-worker.js";

// Plan 12e, review I1: two runs on the fixed port 8797 shared one Worker, so
// one run's rotation and limiter reached the other run's tests. Each start now
// takes a free port and proves that the answering Worker is its own.

const started: ExampleWorker[] = [];
afterAll(async () => {
  await Promise.all(started.map((w) => w.stop()));
}, 30_000);

const info = (w: ExampleWorker, secret: string) =>
  fetch(`${w.base}/auth/operator/info`, { headers: { authorization: `Operator ${secret}` } });

it("asks the operator info route again after no answer, and refuses only another status", () => {
  expect([200, 401, 404, 500, null].map(ownerOf)).toEqual([
    "own",
    "other",
    "other",
    "other",
    "wait",
  ]);
});

it(
  "starts two Workers at once on two ports, and each accepts only its own operator secret",
  async () => {
    assertFreshBuild();
    const results = await Promise.allSettled([startExampleWorker(), startExampleWorker()]);
    for (const r of results) if (r.status === "fulfilled") started.push(r.value);
    const reasons = results.map((r) => (r.status === "rejected" ? String(r.reason) : "started"));
    expect(
      results.map((r) => r.status),
      reasons.join("\n").slice(0, 600),
    ).toEqual(["fulfilled", "fulfilled"]);
    const [a, b] = started;
    if (!a || !b) throw new Error("two Workers did not start");
    expect(a.port).not.toBe(b.port);
    expect((await info(a, a.operatorSecret)).status).toBe(200);
    expect((await info(b, b.operatorSecret)).status).toBe(200);
    expect((await info(a, b.operatorSecret)).status).not.toBe(200);
    expect((await info(b, a.operatorSecret)).status).not.toBe(200);
  },
  START_LIMIT_MS + 30_000,
);
