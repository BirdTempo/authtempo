import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import type { HooksConfig } from "../src/engine/hooks.js";
import { resolveSession } from "../src/engine/sessions.js";
import { completeSocial, startLink, startSocial } from "../src/engine/social.js";
import { createRouter } from "../src/http/router.js";
import { socialRoutes } from "../src/http/routes/social.js";
import { toBase64Url } from "../src/primitives/crypto.js";
import type { SecretVersion } from "../src/primitives/keyring.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { APP_ORIGIN, BASE_URL, get } from "./helpers.js";
import {
  type FakeIdToken,
  fakeJwt,
  GOOGLE,
  googleClaims,
  stateRow,
  tokenEndpoint,
} from "./social-helpers.js";

// Plan 12i Task 19: the app payload rides the state row sealed, and only
// the two hook events see it in clear.
const S1 = "0123456789abcdef0123456789abcdef";
const S2 = "q8JxVd3m0Yv2sZ7rKpT4wN1hLc9eFgAuBiOjQyRtSxM";
const ONE: SecretVersion[] = [{ version: 1, value: S1 }];
const PHASE_1: SecretVersion[] = [
  { version: 1, value: S1 },
  { version: 2, value: S2 },
];
const PHASE_2: SecretVersion[] = [
  { version: 2, value: S2 },
  { version: 1, value: S1 },
];
const ONLY_2: SecretVersion[] = [{ version: 2, value: S2 }];
const PRO = { plan: "pro" };

/** The base64url of the UTF-8 JSON text. */
function encoded(text: string): string {
  return toBase64Url(new TextEncoder().encode(text));
}

/** The clear forms of the payload `{ plan: "pro" }`. A base64url value holds no quote and no backslash. */
function holdsPro(text: string): boolean {
  return (
    text.includes('"pro"') ||
    text.includes('\\"pro\\"') ||
    text.includes('"plan"') ||
    text.includes(encoded(JSON.stringify(PRO)))
  );
}

interface Seen {
  sessions: Array<{ via: string; stateData?: Record<string, unknown> }>;
  links: Array<{ via: string; stateData?: Record<string, unknown> }>;
}

/** One storage and one clock, and a config per secret list over them. */
function world(stateData: { maxBytes?: number } | false = {}) {
  let current = new Date("2026-10-22T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const storage = createMemoryAdapter();
  const jwtTokens: Record<string, FakeIdToken> = {};
  const seen: Seen = { sessions: [], links: [] };
  const hooks: HooksConfig = {
    session: {
      afterCreate: (e) => {
        seen.sessions.push({ via: e.via, ...(e.stateData ? { stateData: e.stateData } : {}) });
      },
    },
    identity: {
      afterLink: (e) => {
        seen.links.push({ via: e.via, ...(e.stateData ? { stateData: e.stateData } : {}) });
      },
    },
  };
  const config = (secrets: SecretVersion[] = ONE, extra: Partial<AuthConfig> = {}) =>
    resolveConfig({
      baseURL: BASE_URL,
      trustedOrigins: [APP_ORIGIN],
      storage,
      mail: { send: async () => {} },
      clock,
      secrets,
      social: {
        google: GOOGLE,
        fetch: tokenEndpoint("idtok-default").fetchFn,
        stateData,
      },
      jwt: fakeJwt(jwtTokens),
      hooks,
      ...extra,
    });
  return { storage, clock, jwtTokens, seen, config };
}

type World = ReturnType<typeof world>;
type Config = ReturnType<World["config"]>;

/** A Google start with `data`: the state, the nonce, and the binding value. */
async function start(config: Config, data: string | undefined) {
  const r = await startSocial(config, { provider: "google", next: "/home", data, ip: "1.1.1.1" });
  if (!r.ok) throw new Error(`start failed: ${r.code}`);
  const url = new URL(r.value.location);
  return {
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    bindToken: r.value.bindToken,
  };
}

function complete(
  w: World,
  config: Config,
  s: Awaited<ReturnType<typeof start>>,
  claims: Record<string, unknown> = {},
  sessionToken?: string,
) {
  w.jwtTokens["idtok-default"] = googleClaims(s.nonce, claims);
  return completeSocial(config, {
    provider: "google",
    state: s.state,
    code: "c",
    error: null,
    bindToken: s.bindToken,
    ip: null,
    userAgent: null,
    ...(sessionToken !== undefined ? { sessionToken } : {}),
  });
}

async function stateRows(w: World) {
  return w.storage.findMany("verification", [
    { field: "purpose", op: "in", value: ["oauth-state", "oauth-link-state"] },
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the sealed state payload (plan 12i Task 19)", () => {
  it("passes the payload to the session hook at the callback", async () => {
    const w = world();
    const config = w.config();
    const done = await complete(w, config, await start(config, encoded(JSON.stringify(PRO))));
    if (!done.ok || !("token" in done.value)) throw new Error("no session");
    expect(w.seen.sessions).toEqual([{ via: "social", stateData: { plan: "pro" } }]);
    // The new user links Google at the sign-in.
    expect(w.seen.links).toEqual([{ via: "sign_in", stateData: { plan: "pro" } }]);
    // A start with no payload gives the hooks none.
    w.clock.advance(1000);
    const again = await complete(w, config, await start(config, undefined));
    expect(again.ok).toBe(true);
    expect(w.seen.sessions[1]).toEqual({ via: "social" });
    // A link (plan 12a) gives it to identity.afterLink with via link.
    const resolved = await resolveSession(config, done.value.token);
    if (!resolved) throw new Error("no session");
    const linkStart = await startLink(config, {
      provider: "google",
      session: resolved,
      data: encoded('{"team":"blue"}'),
      ip: "1.1.1.1",
    });
    if (!linkStart.ok) throw new Error(`link start failed: ${linkStart.code}`);
    const url = new URL(linkStart.value.location);
    const linked = await complete(
      w,
      config,
      {
        state: url.searchParams.get("state") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
        bindToken: linkStart.value.bindToken,
      },
      { sub: "g-2" },
      done.value.token,
    );
    expect(linked).toMatchObject({ ok: true, value: { linked: true } });
    expect(w.seen.links.at(-1)).toEqual({ via: "link", stateData: { team: "blue" } });
  });

  it("refuses 1025 bytes, a depth of 5, an array, and a value that is not base64url JSON", async () => {
    const w = world();
    const config = w.config();
    const refused = [
      encoded(`{"p":"${"x".repeat(1017)}"}`),
      encoded('{"a":{"b":{"c":{"d":{"e":1}}}}}'),
      encoded('[{"plan":"pro"}]'),
      encoded("not json"),
      "not base64url!",
      // A lone continuation byte is not UTF-8.
      toBase64Url(new Uint8Array([0x7b, 0x80, 0x7d])),
    ];
    expect(new TextEncoder().encode(`{"p":"${"x".repeat(1017)}"}`).length).toBe(1025);
    for (const data of refused)
      expect(
        await startSocial(config, { provider: "google", data, ip: "1.1.1.1" }),
        data.slice(0, 20),
      ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await stateRows(w)).toEqual([]);
    // The bounds themselves pass: 1024 bytes, and a depth of 4.
    for (const data of [
      encoded(`{"p":"${"x".repeat(1016)}"}`),
      encoded('{"a":{"b":{"c":{"d":1}}}}'),
    ])
      expect((await startSocial(config, { provider: "google", data, ip: "1.1.1.1" })).ok).toBe(
        true,
      );
    expect(await stateRows(w)).toHaveLength(2);
    // A smaller maxBytes bounds it lower.
    const small = world({ maxBytes: 16 }).config();
    expect(
      await startSocial(small, {
        provider: "google",
        data: encoded('{"p":"0123456789"}'),
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
  });

  it("seals the payload in the row", async () => {
    const w = world();
    // Version 1 is current, and version 2 is added beside it.
    const phase1 = w.config(PHASE_1);
    const s = await start(phase1, encoded(JSON.stringify(PRO)));
    const row = await stateRow(w.storage, s.state);
    if (!row) throw new Error("no row");
    expect(holdsPro(JSON.stringify(row))).toBe(false);
    expect(typeof row.data?.sealedData).toBe("string");
    expect(row.secretVersion).toBe(1);
    // Version 2 becomes current: the row sealed under version 1 still opens.
    const done = await complete(w, w.config(PHASE_2), s);
    expect(done.ok).toBe(true);
    expect(w.seen.sessions).toEqual([{ via: "social", stateData: { plan: "pro" } }]);
  });

  it("never writes the payload into a redirect, an answer, or a line", async () => {
    const lines = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const w = world();
    // A hook that throws makes a line of its own.
    const config = w.config(ONE, {
      hooks: {
        identity: {
          afterLink: () => {
            throw new Error("app hook failed");
          },
        },
      },
    });
    const handle = createRouter(config, socialRoutes(config));
    const data = encoded(JSON.stringify(PRO));
    const answers: Response[] = [];
    const started = await handle(get(`/auth/social/google/start?next=%2Fhome&data=${data}`));
    answers.push(started);
    expect(started.status).toBe(302);
    const to = new URL(started.headers.get("location") ?? "");
    const cookie = (started.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    w.jwtTokens["idtok-default"] = googleClaims(to.searchParams.get("nonce") ?? "", {});
    const callback = `/auth/social/google/callback?code=c&state=${to.searchParams.get("state")}`;
    const done = await handle(get(callback, { cookie }));
    answers.push(done);
    expect(done.status).toBe(302);
    expect(new URL(done.headers.get("location") ?? "").pathname).toBe("/home");
    // A replay of the callback, and a refused start.
    answers.push(await handle(get(callback, { cookie })));
    answers.push(await handle(get(`/auth/social/google/start?data=${encoded("[1]")}`)));
    for (const res of answers) {
      expect(holdsPro(res.headers.get("location") ?? "")).toBe(false);
      expect(holdsPro(await res.text())).toBe(false);
    }
    expect(lines.some((l) => l.mock.calls.length > 0)).toBe(true);
    for (const l of lines) expect(holdsPro(JSON.stringify(l.mock.calls))).toBe(false);
  });

  it("answers invalid_body for data with stateData off", async () => {
    const w = world(false);
    const config = w.config();
    const data = encoded(JSON.stringify(PRO));
    expect(await startSocial(config, { provider: "google", data, ip: null })).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    const handle = createRouter(config, socialRoutes(config));
    const res = await handle(get(`/auth/social/google/start?data=${data}`));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("auth_error")).toBe(
      "invalid_body",
    );
    expect(await stateRows(w)).toEqual([]);
    // With no data the start works as before.
    expect((await startSocial(config, { provider: "google", ip: null })).ok).toBe(true);
  });

  it("fails closed for a payload under a version that left the config or moved to another row", async () => {
    const w = world();
    const s = await start(w.config(ONE), encoded(JSON.stringify(PRO)));
    // Version 1 leaves the config while the state is in flight.
    expect(await complete(w, w.config(ONLY_2), s)).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    // A database write that moves a sealed payload to another state row.
    const config = w.config(ONE);
    const a = await start(config, encoded(JSON.stringify(PRO)));
    const b = await start(config, encoded('{"plan":"free"}'));
    const rowA = await stateRow(w.storage, a.state);
    const rowB = await stateRow(w.storage, b.state);
    if (!rowA?.data || !rowB?.data) throw new Error("no row");
    await w.storage.update("verification", [{ field: "id", op: "eq", value: rowB.id }], {
      data: { ...rowB.data, sealedData: rowA.data.sealedData },
    });
    expect(await complete(w, config, b)).toMatchObject({ ok: false, code: "invalid_token" });
    expect(w.seen.sessions).toEqual([]);
    // The untouched row still opens.
    expect((await complete(w, config, a)).ok).toBe(true);
    expect(w.seen.sessions).toEqual([{ via: "social", stateData: { plan: "pro" } }]);
  });
});
