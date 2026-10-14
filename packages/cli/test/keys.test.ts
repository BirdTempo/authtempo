import { describe, expect, it } from "vitest";
import { KEYS_JSON_KEYS } from "../src/json.js";
import { main } from "../src/main.js";
import { fakeIo } from "./support/fake-io.js";

const BASE = "https://api.example.com";
const SECRET = "s3cret-canary-operator-0123456789abcdef";

/** A deployment with the operator route of core: the key set, and one rotation. */
function deployment(o: { jwks?: number; route?: number; listsNewKey?: boolean } = {}) {
  let rotated = false;
  return async (url: string, init: RequestInit): Promise<Response> => {
    if (url === `${BASE}/auth/jwks`) {
      if (o.jwks === 404) return Response.json({ error: "not_found" }, { status: 404 });
      const keys =
        rotated && o.listsNewKey !== false ? [{ kid: "K2" }, { kid: "K1" }] : [{ kid: "K1" }];
      return Response.json({ keys });
    }
    if (url === `${BASE}/auth/operator/keys/rotate` && init.method === "POST") {
      const right = new Headers(init.headers).get("authorization") === `Operator ${SECRET}`;
      const status = o.route ?? (right ? 200 : 401);
      if (status !== 200) return Response.json({ error: "refused" }, { status });
      rotated = true;
      return Response.json({ kid: "K2" });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

async function rotate(args: string[], o: Parameters<typeof fakeIo>[0] = {}) {
  const io = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: SECRET }, fetch: deployment(), ...o });
  const code = await main(["keys", "rotate", ...args], io);
  return { code, io };
}

describe("authtempo keys rotate (spec 19)", () => {
  it("prints the new kid only on stdout, and posts the secret of AUTHTEMPO_OPERATOR_SECRET", async () => {
    const { code, io } = await rotate([BASE, "--yes"]);
    expect(code).toBe(0);
    expect(io.stdout).toEqual(["kid: K2"]);
    expect(io.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${BASE}/auth/jwks`,
      `POST ${BASE}/auth/operator/keys/rotate`,
      `GET ${BASE}/auth/jwks`,
    ]);
    expect(io.requests[1]?.headers.get("authorization")).toBe(`Operator ${SECRET}`);
    expect(io.requests[0]?.headers.get("cache-control")).toBe("no-cache");
    expect(io.stderr).toContain(
      "rotating the signing key of https://api.example.com; the old key verifies for 24 hours",
    );
  });

  it("prints one JSON document with --json", async () => {
    const { code, io } = await rotate([BASE, "--yes", "--json"]);
    expect(code).toBe(0);
    expect(io.stdout).toHaveLength(1);
    const doc = JSON.parse(io.stdout[0] ?? "") as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(Object.keys(KEYS_JSON_KEYS).sort());
    expect(doc).toEqual({ kid: "K2" });
  });

  it("makes no request with no terminal and no --yes, or with --no-input", async () => {
    const plain = await rotate([BASE]);
    expect(plain.code).toBe(2);
    expect(plain.io.requests).toEqual([]);
    expect(plain.io.stderr[0]).toBe(
      "keys rotate asks for a confirmation: give --yes when no person can answer",
    );
    const noInput = await rotate([BASE, "--no-input"], { stdinIsTTY: true, answer: true });
    expect(noInput.code).toBe(2);
    expect(noInput.io.requests).toEqual([]);
  });

  it("asks on a terminal, and makes no request on an answer that is not yes", async () => {
    const no = await rotate([BASE], { stdinIsTTY: true, answer: false });
    expect(no.code).toBe(2);
    expect(no.io.requests).toEqual([]);
    expect(no.io.stderr.at(-1)).toBe("stopped: no rotation: the answer was not yes");
    const yes = await rotate([BASE], { stdinIsTTY: true, answer: true });
    expect(yes.code).toBe(0);
    expect(yes.io.stdout).toEqual(["kid: K2"]);
  });

  it("names the cause of each refusal with exit 2", async () => {
    const cases: [Parameters<typeof deployment>[0], string][] = [
      [
        { jwks: 404 },
        "jwt minting is off, or no deployment answers at https://api.example.com/auth",
      ],
      [
        { route: 404 },
        "the operator route is off: set operator.secretHash in the config of the deployment",
      ],
      [{ route: 401 }, "the deployment refused the operator secret"],
      [
        { route: 429 },
        "the operator route allows 5 calls per IP per hour; wait, then run it again",
      ],
    ];
    for (const [d, reason] of cases) {
      const { code, io } = await rotate([BASE, "--yes"], { fetch: deployment(d) });
      expect(code).toBe(2);
      expect(io.stdout).toEqual([]);
      expect(io.stderr.at(-1)).toContain(`stopped: ${reason}`);
    }
  });

  it("warns, and exits 0, when the key set does not list the new kid yet", async () => {
    const { code, io } = await rotate([BASE, "--yes"], {
      fetch: deployment({ listsNewKey: false }),
    });
    expect(code).toBe(0);
    expect(io.stdout).toEqual(["kid: K2"]);
    expect(io.stderr.at(-1)).toBe(
      "warning: the key set does not list K2 yet; a cache can hold the old set for 300 seconds",
    );
  });

  it("reads the secret from --token-file and from stdin", async () => {
    const file = await rotate([BASE, "--yes", "--token-file", "op.txt"], {
      env: {},
      files: { "/work/op.txt": `${SECRET}\n` },
    });
    expect(file.code).toBe(0);
    const stdin = await rotate([BASE, "--yes", "--token-file", "-"], { env: {}, stdin: SECRET });
    expect(stdin.code).toBe(0);
  });

  it("stops with exit 2 when the host gives no answer, and no line holds the secret", async () => {
    const { code, io } = await rotate([BASE, "--yes"], {
      fetch: async () => {
        throw new TypeError(`fetch failed for Operator ${SECRET}`);
      },
    });
    expect(code).toBe(2);
    expect(io.stderr.at(-1)).toBe(`stopped: GET ${BASE}/auth/jwks: no answer`);
    for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain("s3cret-canary");
  });

  it("refuses a base URL with a path or with credentials, before any request", async () => {
    for (const bad of [`${BASE}/auth`, "https://u:p@api.example.com", "ftp://api.example.com"]) {
      const { code, io } = await rotate([bad, "--yes"]);
      expect(code).toBe(2);
      expect(io.requests).toEqual([]);
      expect(io.stderr[0]).toBe(`${bad} must be an http or https origin with no path`);
    }
  });

  it("refuses http to a host that is not this machine, before the secret is read", async () => {
    const bad = "http://203.0.113.9";
    const message = `${bad} must use https: http is for localhost, 127.0.0.1, or [::1] only`;
    // No secret is set: a read of the secret would stop with another message.
    const unset = await rotate([bad, "--yes"], { env: {} });
    expect(unset.code).toBe(2);
    expect(unset.io.stderr[0]).toBe(message);
    const set = await rotate([bad, "--yes"]);
    expect(set.code).toBe(2);
    expect(set.io.requests).toEqual([]);
    expect(set.io.stderr[0]).toBe(message);
    const local = await rotate(["http://127.0.0.1:8787", "--yes"]);
    expect(local.io.requests[0]?.url).toBe("http://127.0.0.1:8787/auth/jwks");
  });

  it("follows no redirect: a 307 to another origin stops with exit 2, and prints no kid", async () => {
    const inits: RequestInit[] = [];
    const real = deployment();
    const { code, io } = await rotate([BASE, "--yes"], {
      fetch: async (url, init) => {
        inits.push(init);
        if (url === `${BASE}/auth/operator/keys/rotate`)
          return new Response(null, {
            status: 307,
            headers: { location: "https://evil.example.net/rotate" },
          });
        if (url.startsWith("https://evil.example.net")) return Response.json({ kid: "EVIL" });
        return real(url, init);
      },
    });
    expect(code).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.requests.map((r) => r.url)).not.toContain("https://evil.example.net/rotate");
    expect(io.stderr.at(-1)).toBe(
      `stopped: POST ${BASE}/auth/operator/keys/rotate answered 307, a redirect: the CLI follows no redirect`,
    );
    expect(inits.map((i) => i.redirect)).toEqual(["manual", "manual"]);
  });
});
