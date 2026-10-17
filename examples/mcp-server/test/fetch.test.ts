import { describe, expect, it } from "vitest";
import { dohResolve, guardedFetch, isPublicAddress } from "../src/fetch.js";

const URL_OK = "https://client.example.com/metadata.json";
const PRIVATE = "the client metadata host resolves to a private address";

/** A fake fetch that records each request and answers one fixed response. */
function recorder(answer: Response = new Response("{}")) {
  const requests: Request[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return answer;
  }) as typeof fetch;
  return { requests, fetchFn };
}

/** A fake resolve that answers the same list for every name, and records each name. */
function answers(list: string[]) {
  const names: string[] = [];
  const resolve = async (name: string) => {
    names.push(name);
    return list;
  };
  return { names, resolve };
}

// One address in each private class of the guard. Each expected class is a literal here,
// not a value read from the table of src/fetch.ts.
const PRIVATE_CLASSES: readonly [string, string][] = [
  ["0.0.0.0/8", "0.1.2.3"],
  ["10.0.0.0/8", "10.255.255.254"],
  ["100.64.0.0/10", "100.127.255.254"],
  ["127.0.0.0/8", "127.0.0.1"],
  ["169.254.0.0/16", "169.254.169.254"],
  ["172.16.0.0/12", "172.31.255.254"],
  ["192.0.0.0/24", "192.0.0.170"],
  ["192.0.2.0/24", "192.0.2.1"],
  ["192.168.0.0/16", "192.168.1.1"],
  ["198.18.0.0/15", "198.19.255.254"],
  ["198.51.100.0/24", "198.51.100.1"],
  ["203.0.113.0/24", "203.0.113.1"],
  ["224.0.0.0/4", "239.255.255.250"],
  ["240.0.0.0/4", "255.255.255.255"],
  ["::", "::"],
  ["::1", "::1"],
  ["fc00::/7", "fd12:3456:789a::1"],
  ["fe80::/10", "febf:ffff::1"],
  ["fec0::/10", "fec0::1"],
  ["ff00::/8", "ff02::1"],
  ["100::/64", "100::1"],
  ["2001:db8::/32", "2001:db8::1"],
  ["::/96 with a private IPv4 address", "::10.0.0.1"],
  ["::ffff:0:0:0/96 with a private IPv4 address", "::ffff:0:a00:1"],
  ["64:ff9b::/96 with a private IPv4 address", "64:ff9b::a00:1"],
  ["2002::/16 with a private IPv4 address", "2002:a00:1::1"],
];

describe("guardedFetch", () => {
  for (const [range, address] of PRIVATE_CLASSES)
    it(`refuses ${range}`, async () => {
      const { requests, fetchFn } = recorder();
      const guarded = guardedFetch({ resolve: answers([address]).resolve, fetch: fetchFn });
      await expect(guarded(URL_OK)).rejects.toThrow(PRIVATE);
      expect(requests).toHaveLength(0);
    });

  it("refuses a name with one public and one private answer", async () => {
    const { requests, fetchFn } = recorder();
    const guarded = guardedFetch({
      resolve: answers(["93.184.215.14", "10.0.0.5"]).resolve,
      fetch: fetchFn,
    });
    await expect(guarded(URL_OK)).rejects.toThrow(PRIVATE);
    expect(requests).toHaveLength(0);
  });

  it("refuses a name with no answer", async () => {
    const { requests, fetchFn } = recorder();
    const guarded = guardedFetch({ resolve: answers([]).resolve, fetch: fetchFn });
    await expect(guarded(URL_OK)).rejects.toThrow("the client metadata host has no address");
    expect(requests).toHaveLength(0);
  });

  it("refuses an http URL before any lookup", async () => {
    const { requests, fetchFn } = recorder();
    const lookup = answers(["93.184.215.14"]);
    const guarded = guardedFetch({ resolve: lookup.resolve, fetch: fetchFn });
    await expect(guarded("http://client.example.com/metadata.json")).rejects.toThrow(
      "the client metadata URL must be https",
    );
    expect(lookup.names).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("refuses the IPv4-mapped IPv6 form of a private address", async () => {
    for (const address of ["::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:c0a8:0101"]) {
      const { requests, fetchFn } = recorder();
      const guarded = guardedFetch({ resolve: answers([address]).resolve, fetch: fetchFn });
      await expect(guarded(URL_OK), address).rejects.toThrow(PRIVATE);
      expect(requests).toHaveLength(0);
    }
  });

  it("sends the request with redirect manual", async () => {
    const { requests, fetchFn } = recorder();
    const lookup = answers(["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]);
    const guarded = guardedFetch({ resolve: lookup.resolve, fetch: fetchFn });
    await guarded(URL_OK, { headers: { accept: "application/json" } });
    expect(lookup.names).toEqual(["client.example.com"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.redirect).toBe("manual");
    expect(requests[0]?.url).toBe(URL_OK);
    expect(requests[0]?.headers.get("accept")).toBe("application/json");
  });

  it("passes the response of a public answer through unchanged", async () => {
    const answer = new Response('{"client_id":"x"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const { fetchFn } = recorder(answer);
    const guarded = guardedFetch({ resolve: answers(["93.184.215.14"]).resolve, fetch: fetchFn });
    expect(await guarded(URL_OK)).toBe(answer);
  });

  it("stops at the abort of the caller while the name resolves", async () => {
    const { requests, fetchFn } = recorder();
    const never = () => new Promise<string[]>(() => {});
    const guarded = guardedFetch({ resolve: never, fetch: fetchFn });
    const ctrl = new AbortController();
    const pending = guarded(URL_OK, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe("guardedFetch on workerd", () => {
  it("calls the fetch and the lookup with no receiver", async () => {
    const receivers: unknown[] = [];
    const deps = {
      async resolve(this: unknown) {
        receivers.push(this);
        return ["93.184.215.14"];
      },
      fetch: async function (this: unknown) {
        receivers.push(this);
        return new Response("{}");
      } as unknown as typeof fetch,
    };
    await guardedFetch(deps)(URL_OK);
    expect(receivers).toEqual([undefined, undefined]);
  });

  it("works with the real global fetch and lookup of workerd", async () => {
    // The outbound service of vitest.config.ts answers every request: no network.
    const guarded = guardedFetch({ resolve: dohResolve(fetch), fetch });
    const res = await guarded("https://public.example.com/metadata.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: "public.example.com" });
    await expect(guarded("https://private.example.com/metadata.json")).rejects.toThrow(PRIVATE);
  });

  it("refuses an IP literal host with no lookup", async () => {
    for (const url of ["https://[::1]/x", "https://10.0.0.1/x"]) {
      const { requests, fetchFn } = recorder();
      const lookup = answers(["93.184.215.14"]);
      const guarded = guardedFetch({ resolve: lookup.resolve, fetch: fetchFn });
      await expect(guarded(url), url).rejects.toThrow(PRIVATE);
      expect(lookup.names).toHaveLength(0);
      expect(requests).toHaveLength(0);
    }
  });

  it("looks up a host with a trailing dot by its name with no dot", async () => {
    const { fetchFn } = recorder();
    const lookup = answers(["93.184.215.14"]);
    await guardedFetch({ resolve: lookup.resolve, fetch: fetchFn })(
      "https://client.example.com./metadata.json",
    );
    expect(lookup.names).toEqual(["client.example.com"]);
  });
});

describe("isPublicAddress", () => {
  it("accepts public neighbours of each private class", () => {
    for (const address of [
      "1.0.0.0",
      "9.255.255.255",
      "11.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "128.0.0.0",
      "169.253.255.255",
      "172.15.255.255",
      "172.32.0.0",
      "192.0.1.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "223.255.255.255",
      "2606:4700:4700::1111",
      "fbff:ffff::1",
      "fe7f::1",
      "fe00::1",
      "::ffff:93.184.215.14",
      "::93.184.215.14",
      "::ffff:0:5db8:d70e",
      "64:ff9b::5db8:d70e",
      "2002:5db8:d70e::1",
      "100:0:0:1::1",
      "2001:db9::1",
      "192.0.1.255",
      "192.0.3.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
    ])
      expect(isPublicAddress(address), address).toBe(true);
  });

  it("refuses a text that is no address", () => {
    for (const address of ["", "example.com", "256.0.0.1", "1.2.3", "01.2.3.4", "1::2::3", "::g"])
      expect(isPublicAddress(address), address).toBe(false);
  });
});

describe("dohResolve", () => {
  it("asks for A and AAAA as dns-json and answers both, with no CNAME", async () => {
    const asked: Request[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      asked.push(request);
      const type = new URL(request.url).searchParams.get("type");
      const answer =
        type === "A"
          ? [
              { name: "client.example.com", type: 5, data: "edge.example.net." },
              { name: "edge.example.net", type: 1, data: "93.184.215.14" },
            ]
          : [{ name: "edge.example.net", type: 28, data: "2606:2800:21f::1" }];
      return Response.json({ Status: 0, Answer: answer });
    }) as typeof fetch;
    const list = await dohResolve(fetchFn)("client.example.com");
    expect(list.sort()).toEqual(["2606:2800:21f::1", "93.184.215.14"]);
    expect(asked.map((r) => new URL(r.url).searchParams.get("type")).sort()).toEqual(["A", "AAAA"]);
    for (const r of asked) {
      expect(new URL(r.url).origin + new URL(r.url).pathname).toBe(
        "https://cloudflare-dns.com/dns-query",
      );
      expect(new URL(r.url).searchParams.get("name")).toBe("client.example.com");
      expect(r.headers.get("accept")).toBe("application/dns-json");
    }
  });

  it("answers no address for a name that does not exist", async () => {
    const fetchFn = (async () => Response.json({ Status: 3 })) as typeof fetch;
    expect(await dohResolve(fetchFn)("nothing.example.com")).toEqual([]);
  });

  it("sends its requests with redirect manual and the caller's signal", async () => {
    const asked: Request[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(new Request(input, init));
      return Response.json({ Status: 0, Answer: [] });
    }) as typeof fetch;
    const ctrl = new AbortController();
    await dohResolve(fetchFn)("client.example.com", ctrl.signal);
    ctrl.abort();
    expect(asked).toHaveLength(2);
    for (const r of asked) {
      expect(r.redirect).toBe("manual");
      expect(r.signal.aborted).toBe(true);
    }
  });

  it("answers a 200 that is not JSON as a failed lookup", async () => {
    const fetchFn = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    await expect(dohResolve(fetchFn)("client.example.com")).rejects.toThrow(
      "the DNS lookup of the client metadata host failed",
    );
  });

  it("throws when the resolver does not answer 200", async () => {
    const fetchFn = (async () => new Response("no", { status: 502 })) as typeof fetch;
    await expect(dohResolve(fetchFn)("client.example.com")).rejects.toThrow(
      "the DNS lookup of the client metadata host failed",
    );
  });
});
