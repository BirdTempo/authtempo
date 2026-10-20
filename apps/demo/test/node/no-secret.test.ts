import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_TOKEN_PREFIX, SESSION_TOKEN_PREFIX } from "@authtempo/core/credentials";
import { describe, expect, it } from "vitest";
import { DEMO_PLANNED_ORIGIN } from "../../src/facts.ts";

// The demo holds no secret (plan 11b, Global Constraints). These tests read
// wrangler.jsonc, the bundle that scripts/dry-run.mjs writes to dist/bundle/,
// the copied assets of dist/public/, and the source. The build runs the dry
// run, and the test task waits for the build (ruling 44 of the plan 11b lane).
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = join(PKG, "dist", "bundle");
const PUBLIC = join(PKG, "dist", "public");
const SRC = join(PKG, "src");
const PACKAGES = resolve(PKG, "../../packages");

/**
 * Each token prefix that core issues, read from the source of core: each
 * `export const <NAME>_PREFIX = "<prefix>_"`. So a new token form of core joins the scan.
 */
const PREFIXES = files(join(PACKAGES, "core", "src"))
  .filter((f) => f.endsWith(".ts"))
  .flatMap((f) => [
    ...readFileSync(f, "utf8").matchAll(/export const [A-Z_]+_PREFIX = "([a-z]+_)"/g),
  ])
  .map((m) => m[1] ?? "")
  .filter((p, i, all) => all.indexOf(p) === i)
  .sort();

/** The time of the newest file among `paths`, each a file or a folder. */
function newest(paths: readonly string[]): number {
  return Math.max(
    ...paths
      .flatMap((p) => (statSync(p).isDirectory() ? files(p) : [p]))
      .map((f) => statSync(f).mtimeMs),
  );
}

/** The one client secret of the demo provider. It guards nothing (src/provider.ts). */
const DEMO_CLIENT_SECRET = "demo-provider-secret-not-a-secret";
/** The copied assets that are text. The fonts are binary, and no text rule reads them. */
const TEXT_ASSET = /\.(js|css|html|txt|json|map)$|^_headers$/;

/** Every file under `dir`, by its full path. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** JSONC to JSON: each comment goes, and a "//" inside a string stays. */
function stripComments(text: string): string {
  let out = "";
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') quote = false;
    } else if (c === '"') {
      quote = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return out;
}

/**
 * The text that a scan reads from one file. A source map holds the source as
 * JSON strings, so the scan reads each source of it, not the escaped JSON.
 */
function scanText(path: string): string {
  const text = readFileSync(path, "utf8");
  if (!path.endsWith(".map")) return text;
  const map = JSON.parse(text) as { sourcesContent?: (string | null)[] };
  return (map.sourcesContent ?? []).filter((s) => s !== null).join("\n");
}

/**
 * A PEM block of a public certificate: base64 lines and newline escapes only.
 * The bundle holds the root certificates of WebAuthn attestation, which are
 * public. The scan reads the text around each block, never across code.
 */
const PEM = /-----BEGIN ([A-Z ]+)-----(?:[A-Za-z0-9+/=\s]|\\n|\\r)*?-----END \1-----/g;

/**
 * Each long run of the scan alphabet that is public, with where it comes from.
 * A new run fails the scan until it is named here (Task 12 re-review, Low 5).
 */
const PUBLIC_RUNS: Readonly<Record<string, string>> = {
  // The base64 and base64url alphabets of a codec in the bundle.
  ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789: "a base64 alphabet",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_": "the base64url alphabet",
  // A class field name of the X.509 code of the WebAuthn dependencies.
  _Pkcs10CertificateRequest_signatureAlgorithm: "a field name",
  // @simplewebauthn/server 14.0.3: the CBOR bytes of a known bad EdDSA key, and an AAGUID in a comment.
  a301634f4b500327206745643235353139: "a CBOR constant",
  adce000235bcc60a648b0b25f1f05503: "an example AAGUID",
  // zod 4.6.5, core/visit.js, in the source map: a hex value in its source.
  "7e15ae1984bb338c86eb5e452dee3010": "a hex value of zod",
};

/**
 * Each credential form in `text`, after each public PEM block. The scan finds
 * five forms. The first is a token of a core prefix. The second is a hex run
 * of 32 characters or more, as a sandbox id. The third is a base64url run of
 * 43 characters or more with a digit, a capital, and a small letter. That is
 * 32 bytes or more, as a sandbox secret, quoted or not. The fourth is 32
 * bytes in standard base64 with its padding. The last is a string that a
 * name with "secret" in it takes, other than a bare prefix of core. The
 * bundle of core holds `CLIENT_SECRET_PREFIX = "cs_"` (plan 12e). The first
 * form finds each token of that prefix. A random value of 32 bytes in base64url
 * has all three kinds of character. So the rule of three misses almost none,
 * and it passes plain words.
 */
function credentials(text: string): string[] {
  const found: string[] = [];
  const open = text.replace(PEM, " ");
  for (const prefix of PREFIXES) {
    const token = new RegExp(`(?<![A-Za-z0-9_-])${prefix}[A-Za-z0-9_-]{20,}`, "g");
    found.push(...(open.match(token) ?? []));
  }
  for (const m of open.match(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])/g) ?? [])
    if (PUBLIC_RUNS[m] === undefined) found.push(m);
  for (const m of open.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,}(?![A-Za-z0-9_-])/g) ?? [])
    if (/\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) && PUBLIC_RUNS[m] === undefined)
      found.push(m);
  found.push(...(open.match(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g) ?? []));
  // A string that a name with "secret" in it takes, as `name = "v"` or `name: "v"`.
  // An empty string and a template with a value in it are no secret.
  const assigned = /[A-Za-z0-9_$]*secret[A-Za-z0-9_$]*["']?\s*[:=]\s*(["'`])([^"'`\n]*)\1/gi;
  for (const m of open.matchAll(assigned)) {
    const value = m[2] ?? "";
    if (
      value !== "" &&
      !value.includes("${") &&
      value !== DEMO_CLIENT_SECRET &&
      !PREFIXES.includes(value)
    )
      found.push(value);
  }
  return [...new Set(found)];
}

describe("no secret in the demo", () => {
  it("has one var, DEMO_ORIGIN", () => {
    const config = JSON.parse(stripComments(readFileSync(join(PKG, "wrangler.jsonc"), "utf8"))) as {
      vars?: Record<string, unknown>;
    };
    expect(Object.keys(config.vars ?? {})).toEqual(["DEMO_ORIGIN"]);
    expect(config.vars?.DEMO_ORIGIN).toBe("https://demo.authtempo.com");
    // The site reads the planned host from the facts, so the var and the facts are one value.
    expect(config.vars?.DEMO_ORIGIN).toBe(DEMO_PLANNED_ORIGIN);
  });

  it("holds no credential in the bundle", () => {
    const bundle = files(BUNDLE);
    const entry = join(BUNDLE, "worker.js");
    expect(bundle).toContain(entry);
    // A pass proves nothing on an old bundle. The bundle must be newer than each
    // of its inputs: the source, the config, and the dist of each workspace dependency.
    const inputs = [
      SRC,
      join(PKG, "wrangler.jsonc"),
      join(PKG, "package.json"),
      join(PACKAGES, "core", "dist"),
      join(PACKAGES, "adapter-d1", "dist"),
    ];
    expect({ bundleIsNewer: statSync(entry).mtimeMs >= newest(inputs) }).toEqual({
      bundleIsNewer: true,
    });
    const assets = files(PUBLIC).filter((f) => TEXT_ASSET.test(f.split("/").pop() ?? ""));
    expect(assets.length).toBeGreaterThan(0);
    // The same for the copied assets: each one is newer than the files it comes from.
    const oldest = Math.min(...assets.map((f) => statSync(f).mtimeMs));
    const sources = [
      join(SRC, "browser"),
      join(PACKAGES, "client", "dist"),
      join(PACKAGES, "core", "dist"),
    ];
    expect({ assetsAreNewer: oldest >= newest(sources) }).toEqual({ assetsAreNewer: true });
    const scanned = [...bundle, ...assets];
    const found = scanned.flatMap((f) =>
      credentials(scanText(f)).map((c) => `${relative(PKG, f)}: ${c}`),
    );
    expect(found).toEqual([]);
    // The scan reads the bundle: the allowed client secret is in it, once a file at least.
    expect(readFileSync(entry, "utf8")).toContain(`"${DEMO_CLIENT_SECRET}"`);
  });

  it("reads each token prefix of core", () => {
    expect(PREFIXES).toContain(SESSION_TOKEN_PREFIX);
    expect(PREFIXES).toContain(API_TOKEN_PREFIX);
    expect(PREFIXES).toContain("ml_");
    expect(PREFIXES).toContain("cs_");
    expect(PREFIXES.length).toBeGreaterThanOrEqual(17);
  });

  it("finds each credential form that the scan names", () => {
    // Not a hex letter, so a token of a prefix is one finding, not two.
    const key = "x".repeat(43);
    // 32 random bytes in base64url, in standard base64, and 16 bytes in hex, as the demo makes them.
    const secret = "q3Vh8Kd0Lw_2fZpXr-9tNsYbG4mJcE1uAoIyTxWvR6k";
    const padded = "q3Vh8Kd0Lw+2fZpXr/9tNsYbG4mJcE1uAoIyTxWvR6k=";
    const id = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    expect(credentials(`x = "ml_${key}"`)).toEqual([`ml_${key}`]);
    expect(credentials(`x = "ts_${key}"`)).toEqual([`ts_${key}`]);
    expect(credentials(`x = "tk_${key}"`)).toEqual([`tk_${key}`]);
    expect(credentials(`const k = "${secret}"`)).toEqual([secret]);
    // Unquoted, inside a URL, and longer: 64 bytes is 86 characters.
    expect(credentials(`https://x.example/?s=${secret}&a=1`)).toEqual([secret]);
    expect(credentials(`v=${secret}${secret}`)).toEqual([`${secret}${secret}`]);
    expect(credentials(`k: "${padded}"`)).toEqual([padded]);
    expect(credentials(`id=${id};`)).toEqual([id]);
    expect(credentials(`const k = "${"0f".repeat(32)}"`)).toEqual(["0f".repeat(32)]);
    expect(credentials(`clientSecret: "real-value"`)).toEqual(["real-value"]);
    // The allowed forms: the client secret by name, an empty value, a word, a public run.
    expect(credentials(`const CLIENT_SECRET = "${DEMO_CLIENT_SECRET}"`)).toEqual([]);
    expect(credentials(`secretTypeId = ""`)).toEqual([]);
    // A bare prefix of core is no secret (plan 12e). A value after the prefix is still found.
    expect(credentials(`var CLIENT_SECRET_PREFIX = "cs_";`)).toEqual([]);
    expect(credentials(`clientSecret: "cs_short"`)).toEqual(["cs_short"]);
    expect(credentials(`"authorization_response_iss_parameter_supported"`)).toEqual([]);
    expect(credentials(`"sec-ordinary-object-internal-methods-and-slots-2"`)).toEqual([]);
    expect(credentials(`var c = "${Object.keys(PUBLIC_RUNS)[1]}";`)).toEqual([]);
    // A prefix inside a longer name is no token, and 19 characters are too few.
    expect(credentials(`parts_${key} tk_${"a".repeat(19)}`)).toEqual([]);
    // A PEM block is public. A secret after it in the same file is still found.
    const pem = `-----BEGIN CERTIFICATE-----\\nMIIB${"Q".repeat(60)}\\n-----END CERTIFICATE-----`;
    expect(credentials(`const root = "${pem}";`)).toEqual([]);
    expect(credentials(`const root = "${pem}"; const k = "${secret}";`)).toEqual([secret]);
  });

  it("has the config keys of this list only, with observability off", () => {
    // Final review m3 and the Task 12 re-review (Low 1) of plan 11b. The
    // recorder of vitest.config.ts sees fetch only, so a new binding (a
    // service, send_email, or ai) could send a request past it. Spec 24
    // item 11: the demo logs no request, and core writes console.error lines.
    const config = JSON.parse(stripComments(readFileSync(join(PKG, "wrangler.jsonc"), "utf8"))) as {
      observability?: unknown;
      durable_objects?: { bindings?: unknown };
    };
    expect(Object.keys(config).sort()).toEqual([
      "$schema",
      "assets",
      "compatibility_date",
      "compatibility_flags",
      "durable_objects",
      "main",
      "migrations",
      "name",
      "observability",
      "preview_urls",
      "vars",
      "workers_dev",
    ]);
    expect(config.observability).toEqual({ enabled: false });
    expect(config.durable_objects?.bindings).toEqual([
      { name: "SANDBOX", class_name: "Sandbox" },
      { name: "GATE", class_name: "Gate" },
    ]);
  });

  it("opens no socket", () => {
    // A connect() of cloudflare:sockets passes the fetch recorder unseen (Task 12 re-review, probe K1).
    const sources = files(SRC).filter((f) => f.endsWith(".ts"));
    const bundle = files(BUNDLE).filter((f) => /\.m?js$/.test(f));
    expect(bundle.length).toBeGreaterThan(0);
    const found = [...sources, ...bundle].filter((f) =>
      readFileSync(f, "utf8").includes("cloudflare:sockets"),
    );
    expect(found.map((f) => relative(PKG, f))).toEqual([]);
  });

  it("logs nothing", () => {
    const sources = files(SRC).filter((f) => f.endsWith(".ts"));
    expect(sources.length).toBeGreaterThan(0);
    const calls = sources.filter((f) => readFileSync(f, "utf8").includes("console."));
    expect(calls.map((f) => relative(PKG, f))).toEqual([]);
  });
});
