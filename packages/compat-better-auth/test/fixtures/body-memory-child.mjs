// Large body reads at once through the shim (ruling 68 Minor 1 of the 12j lane),
// in a child process with a small heap. body-memory.test.ts starts it as
//   node --max-old-space-size=128 --expose-gc body-memory-child.mjs <path> <K> [live]
// and reads one JSON line. A fatal out-of-memory ends the process with no line.
// It imports the build: the test checks that dist is newer than src first.
// <path> picks the reads, each sent to the handler of the shim (`app.handler`):
//   "sso": K managers each post core's SSO connection write of 8 MiB, with the
//     organization in the query.
//   "register": K managers each post Better Auth's register of 8 MiB, with the
//     organization in the body.
//   "acs": K IPs with no session each post a SAML form of SAML_FORM_MAX to core's ACS.
// Each body streams in chunks of 64 KiB with a turn of the loop between chunks, as a
// slow client sends them. With "live", each sample runs a GC first: the live memory.
// Plan 12l: the shim runs core's manager guard before it reads an SSO write, so each user
// of "sso" and "register" is a manager through the shim's paths. It signs up, verifies,
// signs in, creates its organization on core's POST /organizations/create (the path of
// `organization.create` of the shim's client), and turns TOTP on through Better Auth's
// two paths, as `manager` of sso-helpers.ts does.
import { COOKIE_NAME } from "../../dist/server/shapes.js";

const dist = new URL("../../dist/", import.meta.url);
const compat = await import(new URL("index.js", dist).href);
const plugins = await import(new URL("plugins.js", dist).href);
const core = await import("@authtempo/core");
const { base32Decode, totpCode } = await import("@authtempo/core/testing");
// The build of core that the shim imports: the caps of its own source files.
const coreDist = new URL("./", import.meta.resolve("@authtempo/core"));
const { LARGE_READ_ANON_BUDGET, REQUEST_BODY_MAX } = await import(
  new URL("http/body-cap.js", coreDist).href
);
const { SAML_FORM_MAX } = await import(new URL("engine/sso/saml-sp.js", coreDist).href);

const [path, kText, liveText] = process.argv.slice(2);
const K = Number(kText);
const live = liveText === "live";
const BASE = "https://api.example.com";
const links = [];
const app = compat.betterAuth({
  baseURL: BASE,
  secret: "0123456789abcdef0123456789abcdef",
  database: {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: core.createMemoryAdapter(),
    limiter: core.createMemoryLimiter(core.systemClock),
  },
  advanced: { ipAddress: { ipAddressHeaders: ["x-real-ip"] } },
  authtempo: {
    passwordHash: compat.betterAuthPasswordHash({
      pbkdf2: core.createPbkdf2PasswordHash({ iterations: 1000 }),
    }),
    ssoDns: [{ name: "a", txt: async () => [] }],
  },
  emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
  emailVerification: { sendVerificationEmail: async ({ token }) => void links.push(token) },
  plugins: [
    plugins.organization({ sendInvitationEmail: async () => {} }),
    plugins.twoFactor({ accountLockout: { enabled: false } }),
    compat.sso({}),
  ],
});

/** A JSON post of the shim from `ip`, with the session cookie `cookie`. */
const call = (route, body, cookie, ip) =>
  app.handler(
    new Request(`${BASE}/api/auth${route}`, {
      method: "POST",
      headers: {
        origin: BASE,
        "content-type": "application/json",
        "x-real-ip": ip,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

/** The session cookie and the organization of a new manager of each SSO read. */
const cookies = [];
const organizations = [];
const password = "correct horse battery";
if (path !== "acs")
  for (let i = 0; i < K; i++) {
    const email = `u${i}@example.com`;
    const ip = `10.0.${i >> 8}.${i & 255}`;
    await call("/password/sign-up", { email, password }, "", ip);
    await call("/password/verify", { token: links.at(-1) }, "", ip);
    const r = await call("/password/sign-in", { email, password }, "", ip);
    const c = (r.headers.getSetCookie().find((s) => s.startsWith(`${COOKIE_NAME}=`)) ?? "").split(
      ";",
    )[0];
    if (!c) throw new Error(`no session cookie for ${email}: ${r.status}`);
    const made = await call("/organizations/create", { slug: `u${i}-org`, name: `u${i}` }, c, ip);
    if (made.status !== 200) throw new Error(`no organization for ${email}: ${made.status}`);
    const { organization } = await made.json();
    const enable = await call("/two-factor/enable", { password }, c, ip);
    const { totpURI } = await enable.json();
    const secret = base32Decode(new URL(totpURI).searchParams.get("secret") ?? "");
    const code = await totpCode(secret, new Date());
    const confirm = await call("/two-factor/verify-totp", { code }, c, ip);
    if (confirm.status !== 200) throw new Error(`no TOTP for ${email}: ${confirm.status}`);
    cookies.push(c);
    organizations.push(organization.id);
  }

/** A body of `size` bytes: `head`, then "a" to the end, then `tail`. */
const stream = (size, head, tail) => {
  let sent = 0;
  return new ReadableStream({
    async pull(c) {
      await new Promise((resolve) => setImmediate(resolve));
      if (sent >= size) return c.close();
      const chunk = new Uint8Array(Math.min(65_536, size - sent)).fill(0x61);
      if (sent === 0) chunk.set(new TextEncoder().encode(head));
      if (sent + chunk.length === size)
        chunk.set(new TextEncoder().encode(tail), chunk.length - tail.length);
      sent += chunk.length;
      c.enqueue(chunk);
    },
  });
};

/** The request of read `i`. */
function requestOf(i) {
  if (path === "acs")
    return new Request(`${BASE}/api/auth/sso/01KDVDQ4K0M3BPSSWQAS1JPT17/acs`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://idp.example",
        "x-real-ip": `198.51.${i >> 8}.${i & 255}`,
      },
      body: stream(SAML_FORM_MAX, "SAMLResponse=", ""),
      duplex: "half",
    });
  // Core's create names the organization in its query, the register in its body (plan 12l).
  const organizationId = organizations[i];
  const route =
    path === "sso"
      ? `/sso/connections/create?organizationId=${encodeURIComponent(organizationId)}`
      : "/sso/register";
  const head =
    path === "sso"
      ? '{"idpMetadata":"'
      : `{"organizationId":${JSON.stringify(organizationId)},"idpMetadata":"`;
  return new Request(`${BASE}/api/auth${route}`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json", cookie: cookies[i] },
    body: stream(REQUEST_BODY_MAX, head, '"}'),
    duplex: "half",
  });
}

if (!["sso", "register", "acs"].includes(path) || !(K > 0)) throw new Error(`no path ${path}`);
globalThis.gc();
const base = process.memoryUsage();
const peak = { heap: 0, arrayBuffers: 0, sum: 0 };
const sample = () => {
  if (live) globalThis.gc();
  const m = process.memoryUsage();
  peak.heap = Math.max(peak.heap, m.heapUsed);
  peak.arrayBuffers = Math.max(peak.arrayBuffers, m.arrayBuffers);
  peak.sum = Math.max(peak.sum, m.heapUsed + m.arrayBuffers);
};
const sampler = setInterval(sample, 1);
const started = performance.now();
const answers = await Promise.all(
  Array.from({ length: K }, async (_, i) => {
    const res = await app.handler(requestOf(i));
    sample();
    const location = res.headers.get("location");
    if (location !== null)
      return `${res.status} ${new URL(location, BASE).searchParams.get("auth_error")}`;
    const body = await res.json().catch(() => null);
    return `${res.status} ${body?.code ?? body?.error ?? ""}`;
  }),
);
clearInterval(sampler);
sample();
const mb = (x) => Math.round(x / 2 ** 20);
console.log(
  JSON.stringify({
    path,
    reads: K,
    live,
    answers,
    ms: Math.round(performance.now() - started),
    baseHeapMB: mb(base.heapUsed),
    baseArrayBuffersMB: mb(base.arrayBuffers),
    peakHeapMB: mb(peak.heap),
    peakArrayBuffersMB: mb(peak.arrayBuffers),
    peakHeapPlusArrayBuffersMB: mb(peak.sum),
    anonForms: Math.floor(LARGE_READ_ANON_BUDGET / SAML_FORM_MAX),
  }),
);
process.exit(0);
