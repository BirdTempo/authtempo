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

/** `n` lines of fake suffixes, about 42 bytes each, as a padded range has. The `extra` line goes last. */
function realistic(n: number, extra?: string): string {
  const lines: string[] = [];
  let x = 0x2545f491;
  for (let i = 0; i < n; i++) {
    let hex = "";
    while (hex.length < 35) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      hex += x.toString(16).toUpperCase().padStart(8, "0");
    }
    lines.push(`${hex.slice(0, 35)}:${i % 3 === 0 ? 0 : (x % 9000) + 1000}`);
  }
  if (extra) lines.push(extra);
  return lines.join("\r\n");
}

/** The body with lines of one character added at the start, to exactly `size` bytes (ASCII). */
function toSize(body: string, size: number): string {
  const fill = size - body.length;
  if (fill < 2) throw new Error("the body is too large for the size");
  // Blank lines: no range line, so they change no answer.
  return `${"\r\n".repeat(Math.floor(fill / 2))}${fill % 2 ? " " : ""}${body}`;
}

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

  it("reads a realistic padded range of about 2,100 lines and 88 KB", async () => {
    // On 2026-10-15 a padded range held 76 to 105 KB (5BAA6: 84,191 bytes, 2,054 lines).
    const body = realistic(2_100, `${SUFFIX}:3`);
    expect(body.split("\r\n")).toHaveLength(2_101);
    expect(body.length).toBeGreaterThan(86_000);
    expect(body.length).toBeLessThan(90_000);
    const f = fake(() => new Response(body, { status: 200 }));
    expect(await createBreachCheck({ fetch: f.fetchFn })("password")).toBe(true);
    const miss = fake(() => new Response(realistic(2_100), { status: 200 }));
    expect(await createBreachCheck({ fetch: miss.fetchFn })("password")).toBe(false);
  });

  it("reads a body of exactly the cap, and refuses one byte more", async () => {
    const exact = toSize(realistic(2_100, `${SUFFIX}:2`), BODY_MAX_BYTES);
    expect(exact.length).toBe(BODY_MAX_BYTES);
    const at = fake(() => new Response(exact, { status: 200 }));
    expect(await createBreachCheck({ fetch: at.fetchFn })("password")).toBe(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const over = fake(() => new Response(`${exact}0`, { status: 200 }));
    expect(await createBreachCheck({ fetch: over.fetchFn })("password")).toBe("unavailable");
    log.mockRestore();
  });

  it("answers unavailable for a 200 with no range line: an empty body or an HTML page", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const body of ["", "<!doctype html><html><body>Sign in to the network</body></html>"]) {
      const f = fake(() => new Response(body, { status: 200 }));
      expect(await createBreachCheck({ fetch: f.fetchFn })("password")).toBe("unavailable");
    }
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
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
