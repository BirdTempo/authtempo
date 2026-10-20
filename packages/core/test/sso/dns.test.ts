import { afterEach, describe, expect, it, vi } from "vitest";
import { DOH_BODY_MAX, dohCloudflare, dohGoogle } from "../../src/engine/sso/dns.js";

const NAME = "_authtempo-challenge.acme.example";

afterEach(() => {
  vi.useRealTimers();
});

/** A fake fetch that answers one body with one status, and keeps each request. */
function fakeFetch(status: number, body: string) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(body, { status, headers: { "content-type": "application/dns-json" } });
  }) as typeof fetch;
  return { fn, requests };
}

/** A DoH JSON answer of NOERROR with one TXT entry per `data` text (the form of Step 1). */
function txtAnswer(owner: string, ...data: string[]): string {
  return JSON.stringify({
    Status: 0,
    TC: false,
    Question: [{ name: `${owner}.`, type: 16 }],
    Answer: data.map((d) => ({ name: `${owner}.`, type: 16, TTL: 300, data: d })),
  });
}

describe("the DoH adapters", () => {
  it("reads the TXT strings of a DoH answer", async () => {
    // Google's form: two quoted parts with nothing between them, and the escapes \" and \\.
    const google = fakeFetch(
      200,
      txtAnswer(NAME, '"authtempo-domain=abc""def"', '"say \\"hi\\" \\\\ now"'),
    );
    expect(await dohGoogle(google.fn).txt(NAME)).toEqual([
      "authtempo-domain=abcdef",
      'say "hi" \\ now',
    ]);
    expect(google.requests[0]?.url).toBe(
      "https://dns.google/resolve?name=_authtempo-challenge.acme.example&type=TXT",
    );
    // Cloudflare's presentation form: one space between the parts. The space is no part of the value.
    const cloudflare = fakeFetch(200, txtAnswer(NAME, '"authtempo-domain=abc" "def"'));
    expect(await dohCloudflare(cloudflare.fn).txt(NAME)).toEqual(["authtempo-domain=abcdef"]);
    const request = cloudflare.requests[0];
    expect(request?.url).toBe(
      "https://cloudflare-dns.com/dns-query?name=_authtempo-challenge.acme.example&type=TXT",
    );
    expect(request?.init?.redirect).toBe("manual");
    expect(new Headers(request?.init?.headers).get("accept")).toBe("application/dns-json");
    expect(request?.init?.signal).toBeInstanceOf(AbortSignal);
    // The owner name compares with no case and with no trailing dot.
    const upper = fakeFetch(200, txtAnswer(NAME.toUpperCase(), '"v"'));
    expect(await dohGoogle(upper.fn).txt(NAME)).toEqual(["v"]);
  });

  it("answers null past the body cap, on a status, and on a bad Status", async () => {
    const pad = "x".repeat(DOH_BODY_MAX);
    const answers: [string, number, string][] = [
      ["past the body cap", 200, txtAnswer(NAME, `"${pad}"`)],
      ["a status of 500", 500, txtAnswer(NAME, '"v"')],
      ["a redirect", 302, txtAnswer(NAME, '"v"')],
      ["SERVFAIL", 200, JSON.stringify({ Status: 2 })],
      ["no Status", 200, JSON.stringify({ Answer: [] })],
      ["a Status that is text", 200, JSON.stringify({ Status: "0", Answer: [] })],
      ["not JSON", 200, "<html>busy</html>"],
      ["an Answer that is not a list", 200, JSON.stringify({ Status: 0, Answer: {} })],
      [
        "an entry with no type",
        200,
        JSON.stringify({ Status: 0, Answer: [{ name: NAME, data: '"v"' }] }),
      ],
      [
        "an entry with no name",
        200,
        JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"v"' }] }),
      ],
      [
        "a data that is not text",
        200,
        JSON.stringify({ Status: 0, Answer: [{ name: NAME, type: 16, data: 7 }] }),
      ],
      ["an unquoted data", 200, txtAnswer(NAME, "authtempo-domain=abc")],
      ["an unquoted part before a quoted part", 200, txtAnswer(NAME, 'authtempo-domain=abc "def"')],
      ["text between the parts", 200, txtAnswer(NAME, '"a"x"b"')],
      ["an open quote", 200, txtAnswer(NAME, '"abc')],
      ["a decimal escape", 200, txtAnswer(NAME, '"\\065bc"')],
    ];
    for (const [why, status, body] of answers) {
      const f = fakeFetch(status, body);
      expect(await dohCloudflare(f.fn).txt(NAME), why).toBeNull();
    }
    const thrown = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    expect(await dohGoogle(thrown).txt(NAME)).toBeNull();
    // NXDOMAIN, and NOERROR with no Answer: the name has no TXT record.
    expect(await dohCloudflare(fakeFetch(200, JSON.stringify({ Status: 3 })).fn).txt(NAME)).toEqual(
      [],
    );
    expect(await dohCloudflare(fakeFetch(200, JSON.stringify({ Status: 0 })).fn).txt(NAME)).toEqual(
      [],
    );
    // A body just under the cap is read.
    const under = "y".repeat(DOH_BODY_MAX - txtAnswer(NAME, '""').length);
    expect(await dohCloudflare(fakeFetch(200, txtAnswer(NAME, `"${under}"`)).fn).txt(NAME)).toEqual(
      [under],
    );
  });

  it("skips an entry of another owner name or another type", async () => {
    // A CNAME at the asked name: the TXT strings belong to the target, not to the asked name.
    const body = JSON.stringify({
      Status: 0,
      Answer: [
        { name: `${NAME}.`, type: 5, TTL: 300, data: "proof.attacker.example." },
        { name: "proof.attacker.example.", type: 16, TTL: 300, data: '"authtempo-domain=abc"' },
        { name: `${NAME}.`, type: 16, TTL: 300, data: '"authtempo-domain=own"' },
      ],
    });
    expect(await dohGoogle(fakeFetch(200, body).fn).txt(NAME)).toEqual(["authtempo-domain=own"]);
  });

  it("answers null when the resolver gives no answer in 10 seconds", async () => {
    vi.useFakeTimers();
    // A resolver that answers only when the request aborts.
    const hang = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    let settled = false;
    const answer = dohCloudflare(hang)
      .txt(NAME)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBeNull();
  });
});
