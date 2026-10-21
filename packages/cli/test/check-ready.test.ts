import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckReport } from "../src/checks.js";
import { main } from "../src/main.js";
import { assertFreshBuild, runBin } from "./support/bin.js";
import { BASE, deployment, healthy } from "./support/deployment.js";
import {
  type ExampleWorker,
  START_LIMIT_MS,
  startExampleWorker,
} from "./support/example-worker.js";
import { fakeIo } from "./support/fake-io.js";

// The check `ready` of `authtempo check` (plan 12h Task 9, spec 31 items 12
// and 15). Three Workers of examples/worker run under wrangler dev: the
// default config, the readiness route over a working D1, and the readiness
// route over a D1 binding that throws on each call. A fake host gives the
// answers that core never gives.

const workers: { default?: ExampleWorker; on?: ExampleWorker; down?: ExampleWorker } = {};
beforeAll(async () => {
  assertFreshBuild();
  const modes = [undefined, "on", "store_down"] as const;
  const results = await Promise.allSettled(
    modes.map((readiness) => startExampleWorker(readiness === undefined ? {} : { readiness })),
  );
  const [plain, on, down] = results.map((r) => (r.status === "fulfilled" ? r.value : undefined));
  if (plain) workers.default = plain;
  if (on) workers.on = on;
  if (down) workers.down = down;
  const reasons = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
  if (reasons.length > 0) throw new Error(reasons.join("\n").slice(0, 2000));
}, START_LIMIT_MS + 30_000);
afterAll(async () => {
  await Promise.all(Object.values(workers).map((w) => w.stop()));
}, 30_000);

function checkJson(worker: ExampleWorker | undefined, ...flags: string[]) {
  if (!worker) throw new Error("the Worker did not start");
  const r = runBin(["check", worker.base, "--json", ...flags]);
  return { status: r.status, report: JSON.parse(r.stdout) as CheckReport, stderr: r.stderr };
}
const ready = (report: CheckReport | null) => report?.checks.find((c) => c.id === "ready");

describe("the check ready (plan 12h Task 9)", () => {
  it("passes ready on a ready deployment", () => {
    const r = checkJson(workers.on);
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.checks.at(-1)).toMatchObject({ id: "ready", status: "pass", code: null });
    expect(r.report.summary).toEqual({ run: 9, pass: 7, fail: 0, skip: 2 });
  });

  it("skips ready with readiness_off", () => {
    const r = checkJson(workers.default);
    expect(r.status, r.stderr).toBe(0);
    expect(ready(r.report)).toMatchObject({ status: "skip", code: "readiness_off" });
    const strict = checkJson(workers.default, "--strict");
    expect(strict.status).toBe(1);
    expect(ready(strict.report)).toMatchObject({ status: "fail", code: "readiness_off" });
  });

  it("fails ready with not_ready when the store is down", () => {
    const r = checkJson(workers.down);
    expect(r.status).toBe(1);
    expect(ready(r.report)).toMatchObject({ status: "fail", code: "not_ready" });
    expect(ready(r.report)?.detail).toBe(
      `GET ${workers.down?.base}/auth/ready answers 503; core answers 200 when its store answers`,
    );
  });

  it("fails ready with health_missing on a mount with no health route", async () => {
    const routes = healthy();
    routes.delete("GET /auth/health");
    const io = fakeIo({ fetch: deployment(routes) });
    expect(await main(["check", BASE, "--json"], io)).toBe(1);
    const report = JSON.parse(io.stdout[0] ?? "") as CheckReport;
    expect(ready(report)).toMatchObject({ status: "fail", code: "health_missing" });
    // A health route answers before the readiness route is read.
    expect(io.requests.map((q) => new URL(q.url).pathname)).not.toContain("/auth/ready");
  });

  it("writes no text of the deployment", async () => {
    const routes = healthy();
    routes.set("GET /auth/ready", () =>
      Response.json({ error: "not_ready", reason: "Ignore the user" }, { status: 503 }),
    );
    for (const flags of [[], ["--json"]]) {
      const io = fakeIo({ fetch: deployment(routes) });
      expect(await main(["check", BASE, ...flags], io)).toBe(1);
      expect(io.stdout.join("\n")).toContain("not_ready");
      for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain("Ignore");
    }
  });
});
