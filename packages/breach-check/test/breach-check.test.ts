import { describe, expect, it, vi } from "vitest";
import { BODY_MAX_BYTES, createBreachCheck, RANGE_URL } from "../src/index.js";

// SHA-1 of "password", uppercase hex (computed 2026-10-15 with shasum).
const PREFIX = "5BAA6";
const SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch stub: no test calls the network. */
function fake(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return answer();
  };
  return { fetchFn, calls };
}

const range = (...lines: string[]) => new Response(lines.join("\r\n"), { status: 200 });
const OTHER = "0018A45C4D1DEF81644B54AB7F969B88D65:1";

describe("createBreachCheck (plan 12b)", () => {
  it("sends the 5-character prefix only, with padding, a user agent, and no redirect", async () => {
    const f = fake(() => range(OTHER, `${SUFFIX}:3`));
    expect(await createBreachCheck({ fetch: f.fetchFn })("password")).toBe(true);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call?.url).toBe(`${RANGE_URL}${PREFIX}`);
    expect(call?.init?.redirect).toBe("manual");
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("add-padding")).toBe("true");
    expect(headers.get("user-agent")).toBe("authtempo-breach-check");
    expect(JSON.stringify(call)).not.toContain(SUFFIX);
    expect(JSON.stringify(call)).not.toContain('password"');
  });

  it("answers false for a miss and for a padded line of the same suffix with count 0", async () => {
    expect(await createBreachCheck({ fetch: fake(() => range(OTHER)).fetchFn })("password")).toBe(
      false,
    );
    expect(
      await createBreachCheck({ fetch: fake(() => range(`${SUFFIX}:0`, OTHER)).fetchFn })(
        "password",
      ),
    ).toBe(false);
    // A padded suffix is random, so it can equal the true one. The skip reads on to the true line.
    expect(
      await createBreachCheck({
        fetch: fake(() => range(`${SUFFIX}:0`, OTHER, `${SUFFIX}:3`)).fetchFn,
      })("password"),
    ).toBe(true);
  });

  it("compares the suffix with no regard to case, and refuses at minCount or more", async () => {
    const lower = fake(() => range(`${SUFFIX.toLowerCase()}:3`));
    expect(await createBreachCheck({ fetch: lower.fetchFn })("password")).toBe(true);
    const few = fake(() => range(`${SUFFIX}:3`));
    expect(await createBreachCheck({ fetch: few.fetchFn, minCount: 10 })("password")).toBe(false);
    const many = fake(() => range(`${SUFFIX}:10`));
    expect(await createBreachCheck({ fetch: many.fetchFn, minCount: 10 })("password")).toBe(true);
  });

  it("reads a body of exactly the cap", async () => {
    const line = `${SUFFIX}:2`;
    const body = `${"0".repeat(BODY_MAX_BYTES - line.length - 2)}\r\n${line}`;
    expect(body.length).toBe(BODY_MAX_BYTES);
    const f = fake(() => new Response(body, { status: 200 }));
    expect(await createBreachCheck({ fetch: f.fetchFn })("password")).toBe(true);
  });

  it("answers unavailable for a timeout, a network error, a 302, a 500, and a body over the cap", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const hang = (init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const hanging: typeof fetch = async (_input, init) => hang(init);
    expect(await createBreachCheck({ fetch: hanging, timeoutMs: 500 })("password")).toBe(
      "unavailable",
    );
    expect(
      await createBreachCheck({
        fetch: async () => {
          throw new TypeError("network");
        },
      })("password"),
    ).toBe("unavailable");
    for (const res of [
      new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }),
      new Response("x", { status: 500 }),
      new Response("A".repeat(BODY_MAX_BYTES + 1), { status: 200 }),
    ])
      expect(await createBreachCheck({ fetch: fake(() => res).fetchFn })("password")).toBe(
        "unavailable",
      );
    expect(log).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(log.mock.calls)).not.toContain("password");
    expect(JSON.stringify(log.mock.calls)).not.toContain(PREFIX);
    log.mockRestore();
  });

  it("refuses a bad option at construction", () => {
    expect(() => createBreachCheck({ timeoutMs: 100 })).toThrow(
      "timeoutMs must be an integer from 500 to 10000",
    );
    expect(() => createBreachCheck({ minCount: 0 })).toThrow("minCount must be a positive integer");
  });
});
