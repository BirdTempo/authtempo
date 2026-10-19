// Review Focus 1 of plan 11a: the Worker answers a URL with no trailing slash
// and a missing page the way a reader expects. It runs `wrangler dev` on the
// built dist and checks each answer below; the summary line counts them. Plan
// 11b adds the headers of dist/_headers on / and /docs/, and the type of the
// feed. It is not part of `pnpm test`, because wrangler dev takes seconds to
// start.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { DIST, SITE } from "./lib/paths.ts";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

// SMOKE_WRANGLER_ARGS replaces the wrangler arguments. Only the proof of this
// script's failure path uses it (a wrong argument must fail at once).
const wranglerArgs = process.env.SMOKE_WRANGLER_ARGS?.split(" ") ?? [
  "dev",
  "--ip",
  "127.0.0.1",
  "--port",
  String(PORT),
];

// A server already on the port is a stale wrangler from an earlier run, and
// the checks below would read its old content. Fail before the spawn.
const stale = await fetch(`${BASE}/`).then(
  () => true,
  () => false,
);
if (stale) {
  console.error(`preview-smoke: FAIL port ${PORT} already answers; stop that server first`);
  process.exit(1);
}

// detached: the child leads its own process group, so one kill ends pnpm,
// wrangler, and workerd. Without it workerd outlives the run.
const dev = spawn("pnpm", ["exec", "wrangler", ...wranglerArgs], {
  cwd: SITE,
  // The hidden banner skips wrangler's npm update check: its socket can hold the child (seen 2026-10-18).
  env: {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_HIDE_BANNER: "true",
    NO_COLOR: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
  detached: true,
});

let stderrTail = "";
dev.stderr.on("data", (chunk: Buffer) => {
  stderrTail = (stderrTail + chunk.toString()).split("\n").slice(-15).join("\n");
});
let exited: string | null = null;
// "close" fires after the stderr pipe ends, so the tail holds the last lines
// of wrangler. "exit" can fire first, and the message then lacks the cause.
dev.on("close", (code, signal) => {
  exited = `wrangler dev exited (code ${code}, signal ${signal}): ${stderrTail.trim()}`;
});

function killGroup(): void {
  try {
    if (dev.pid !== undefined) process.kill(-dev.pid, "SIGTERM");
  } catch {
    // The group is already gone.
  }
}
// The shell convention: 128 plus the signal number, so a caller sees which
// signal ended the run (SIGINT 2 gives 130, SIGTERM 15 gives 143).
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    killGroup();
    process.exit(SIGNAL_EXIT[sig]);
  });

async function ready(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (exited) throw new Error(exited);
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("wrangler dev did not answer within 60 s");
}

/**
 * The CSP value of dist/_headers, which write-headers.ts wrote (plan 11b Task 3),
 * or null. The Worker must send this value on each page, so the smoke compares
 * the header of each answer with it.
 */
function builtPolicy(): string | null {
  if (!existsSync(`${DIST}_headers`)) return null;
  const line = /^\s+Content-Security-Policy:\s*(.*)$/m.exec(
    readFileSync(`${DIST}_headers`, "utf8"),
  );
  return line?.[1]?.trim() ?? null;
}

/** The other headers of the rule for /* in dist/_headers, by lower-case name (check-csp holds their values). */
function builtSiteHeaders(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(`${DIST}_headers`)) return out;
  let rule = "";
  for (const line of readFileSync(`${DIST}_headers`, "utf8").split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) rule = line.trim();
    else if (rule === "/*") {
      const m = /^\s+([^:\s]+)\s*:\s*(.*)$/.exec(line);
      const name = m?.[1]?.toLowerCase();
      if (name !== undefined && name !== "content-security-policy")
        out.set(name, (m?.[2] ?? "").trim());
    }
  }
  return out;
}

/** The verdict on the other headers of a page: each header of the rule for /*, with its value. */
function siteHeadersAnswer(res: Response): string | null {
  const want = builtSiteHeaders();
  console.log(
    `preview-smoke: ${new URL(res.url).pathname} status=${res.status} ${[...want.keys()].map((n) => `${n}=${res.headers.get(n) ?? "(none)"}`).join(" ")}`,
  );
  if (res.status !== 200) return `status ${res.status}`;
  if (want.size !== 3)
    return `the rule for /* of dist/_headers has ${want.size} other headers; it has 3`;
  for (const [name, value] of want)
    if (res.headers.get(name) !== value)
      return `${name} ${res.headers.get(name) ?? "(none)"}, not ${value}`;
  return null;
}

/** The verdict on the CSP header of one page: equal to the line of dist/_headers. */
function policyAnswer(res: Response): string | null {
  const want = builtPolicy();
  const got = res.headers.get("content-security-policy");
  console.log(
    `preview-smoke: ${new URL(res.url).pathname} status=${res.status} content-security-policy=${got === null ? "(none)" : `${got.length} characters`}`,
  );
  if (res.status !== 200) return `status ${res.status}`;
  if (want === null) return "dist/_headers has no Content-Security-Policy line";
  if (got === null)
    return "no content-security-policy header; wrangler dev did not apply dist/_headers";
  return got === want ? null : `content-security-policy ${got} is not the line of dist/_headers`;
}

const failures: string[] = [];
let checks = 0;
async function expectAnswer(path: string, test: (res: Response, body: string) => string | null) {
  checks++;
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const problem = test(res, await res.text());
  if (problem) failures.push(`${path}: ${problem}`);
}

/**
 * The verdict on one agent file: status 200 and a text content type. It
 * prints the content type, so the run records what the Worker answered.
 */
function agentAnswer(res: Response, problem: string | null): string | null {
  const type = res.headers.get("content-type") ?? "(none)";
  console.log(
    `preview-smoke: ${new URL(res.url).pathname} status=${res.status} content-type=${type}`,
  );
  if (res.status !== 200) return `status ${res.status}`;
  if (!type.startsWith("text/"))
    return `content-type ${type}, not a text type, so a client may take it as a download`;
  return problem;
}

try {
  await ready();
  await expectAnswer("/", (res, body) =>
    res.status !== 200
      ? `status ${res.status}`
      : body.includes("Read the docs")
        ? null
        : 'status 200 but the body lacks "Read the docs"',
  );
  await expectAnswer("/docs/", (res) => (res.status === 200 ? null : `status ${res.status}`));
  // Plan 11b Task 3: the Worker sends the CSP of dist/_headers on a root page and on a docs page.
  await expectAnswer("/", (res) => policyAnswer(res));
  // Spec 24 item 5: Referrer-Policy, X-Content-Type-Options, and Permissions-Policy on a root page.
  await expectAnswer("/", (res) => siteHeadersAnswer(res));
  await expectAnswer("/docs/", (res) => policyAnswer(res));
  await expectAnswer("/docs", (res) =>
    (res.status === 307 || res.status === 308) && res.headers.get("location") === "/docs/"
      ? null
      : `status ${res.status}, location ${res.headers.get("location")}`,
  );
  await expectAnswer("/docs/no-such-page/", (res, body) =>
    res.status !== 404
      ? `status ${res.status}`
      : body.includes("404")
        ? null
        : 'status 404 but the body lacks "404"',
  );
  await expectAnswer("/pagefind/pagefind.js", (res) =>
    res.status === 200 ? null : `status ${res.status}`,
  );
  // The agent files of plan 11e. A client reads them as text, so the smoke
  // prints the content type of each, and a download type fails.
  await expectAnswer("/llms.txt", (res, body) =>
    agentAnswer(
      res,
      body.startsWith("# authtempo\n") ? null : "the body does not start with # authtempo",
    ),
  );
  await expectAnswer("/docs/start/index.md", (res) => agentAnswer(res, null));
  // The OpenAPI document of plan 11g. The rule of public/_headers.template gives
  // this one path a CORS header with no credentials, so a browser tool on
  // another origin reads it.
  await expectAnswer("/docs/reference/openapi.json", (res) => {
    const type = res.headers.get("content-type") ?? "(none)";
    const origin = res.headers.get("access-control-allow-origin");
    const credentials = res.headers.get("access-control-allow-credentials");
    console.log(
      `preview-smoke: /docs/reference/openapi.json status=${res.status} content-type=${type} access-control-allow-origin=${origin ?? "(none)"}`,
    );
    if (res.status !== 200) return `status ${res.status}`;
    if (!type.startsWith("application/json")) return `content-type ${type}`;
    if (origin !== "*") return `access-control-allow-origin ${origin ?? "(none)"}, not *`;
    if (credentials !== null) return `access-control-allow-credentials ${credentials}`;
    return null;
  });
  // The rule names one path: a page has no CORS header.
  await expectAnswer("/docs/reference/routes/", (res) => {
    const origin = res.headers.get("access-control-allow-origin");
    if (res.status !== 200) return `status ${res.status}`;
    return origin === null ? null : `access-control-allow-origin ${origin} on a page`;
  });
  // Plan 11b Task 7. The rule for /feed.xml in _headers.template gives the
  // feed the Atom type of RFC 4287 section 7. The CSP still applies, and the
  // body is the feed that build-feed.ts wrote.
  await expectAnswer("/feed.xml", (res, body) => {
    const type = res.headers.get("content-type") ?? "(none)";
    console.log(`preview-smoke: /feed.xml status=${res.status} content-type=${type}`);
    if (res.status !== 200) return `status ${res.status}`;
    if (type !== "application/atom+xml; charset=utf-8")
      return `content-type ${type}, not application/atom+xml; charset=utf-8`;
    if (res.headers.get("content-security-policy") !== builtPolicy())
      return "the CSP of dist/_headers is not on the feed";
    const built = existsSync(`${DIST}feed.xml`) ? readFileSync(`${DIST}feed.xml`, "utf8") : null;
    return body === built ? null : "the body is not dist/feed.xml";
  });
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
} finally {
  killGroup();
}
console.log(
  `preview-smoke: ${failures.length === 0 ? "PASS" : "FAIL"} checks=${checks} failures=${failures.length}`,
);
for (const f of failures) console.error(`preview-smoke: ${f}`);
if (failures.length > 0) process.exit(1);
