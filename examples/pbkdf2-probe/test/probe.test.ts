import { describe, expect, it } from "vitest";
import worker, { MAX_ITERATIONS } from "../src/index.js";

const ask = (query: string, key: string | null, env: { PROBE_KEY?: string }) =>
  worker.fetch(
    new Request(`https://probe.example/probe${query}`, {
      headers: key === null ? {} : { "x-probe-key": key },
    }),
    env,
  );

describe("the PBKDF2 probe (plan 12b)", () => {
  it("answers 403 with no key, a wrong key, or no PROBE_KEY set", async () => {
    expect((await ask("?iterations=1000", null, { PROBE_KEY: "k" })).status).toBe(403);
    expect((await ask("?iterations=1000", "x", { PROBE_KEY: "k" })).status).toBe(403);
    expect((await ask("?iterations=1000", "k", {})).status).toBe(403);
  });

  it("answers 400 for a count that is not an integer from 1 to the maximum", async () => {
    for (const n of ["abc", "0", "1.5", String(MAX_ITERATIONS + 1)])
      expect((await ask(`?iterations=${n}`, "k", { PROBE_KEY: "k" })).status).toBe(400);
  });

  it("runs one derive and answers its count, its result, and its time", async () => {
    const res = await ask("?iterations=1000", "k", { PROBE_KEY: "k" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ iterations: 1000, ok: true, error: null });
  });
});
