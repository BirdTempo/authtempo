import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_TOKEN_PREFIX, SESSION_TOKEN_PREFIX } from "@authtempo/core/credentials";
import { describe, expect, it } from "vitest";

// The demo holds no secret (plan 11b, Global Constraints). These tests read
// wrangler.jsonc, the bundle that scripts/dry-run.mjs writes to dist/bundle/,
// the copied assets of dist/public/, and the source. The test script runs the
// dry run before vitest, so the bundle comes from the same run.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = join(PKG, "dist", "bundle");
const PUBLIC = join(PKG, "dist", "public");
const SRC = join(PKG, "src");

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

/** Each credential form in `text`: a token of a core prefix, a 64-character hex string, a client secret. */
function credentials(text: string): string[] {
  const found: string[] = [];
  for (const prefix of [SESSION_TOKEN_PREFIX, API_TOKEN_PREFIX]) {
    const token = new RegExp(`(?<![A-Za-z0-9_-])${prefix}[A-Za-z0-9_-]{20,}`, "g");
    found.push(...(text.match(token) ?? []));
  }
  found.push(...(text.match(/(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/g) ?? []));
  // A string that a name with "secret" in it takes, as `name = "v"` or `name: "v"`.
  // An empty string and a template with a value in it are no secret.
  const assigned = /[A-Za-z0-9_$]*secret[A-Za-z0-9_$]*["']?\s*[:=]\s*(["'`])([^"'`\n]*)\1/gi;
  for (const m of text.matchAll(assigned)) {
    const value = m[2] ?? "";
    if (value !== "" && !value.includes("${") && value !== DEMO_CLIENT_SECRET) found.push(value);
  }
  return found;
}

describe("no secret in the demo", () => {
  it("has one var, DEMO_ORIGIN", () => {
    const config = JSON.parse(stripComments(readFileSync(join(PKG, "wrangler.jsonc"), "utf8"))) as {
      vars?: Record<string, unknown>;
    };
    expect(Object.keys(config.vars ?? {})).toEqual(["DEMO_ORIGIN"]);
    expect(config.vars?.DEMO_ORIGIN).toBe("https://demo.authtempo.com");
  });

  it("holds no credential in the bundle", () => {
    const bundle = files(BUNDLE);
    const entry = join(BUNDLE, "worker.js");
    expect(bundle).toContain(entry);
    // A pass proves nothing on an old bundle: it must be newer than each source file.
    const newest = Math.max(...files(SRC).map((f) => statSync(f).mtimeMs));
    expect({ bundleIsNewer: statSync(entry).mtimeMs >= newest }).toEqual({ bundleIsNewer: true });
    const assets = files(PUBLIC).filter((f) => TEXT_ASSET.test(f.split("/").pop() ?? ""));
    expect(assets.length).toBeGreaterThan(0);
    const scanned = [...bundle, ...assets];
    const found = scanned.flatMap((f) =>
      credentials(scanText(f)).map((c) => `${relative(PKG, f)}: ${c}`),
    );
    expect(found).toEqual([]);
    // The scan reads the bundle: the allowed client secret is in it, once a file at least.
    expect(readFileSync(entry, "utf8")).toContain(`"${DEMO_CLIENT_SECRET}"`);
  });

  it("finds each credential form that the scan names", () => {
    const key = "a".repeat(43);
    expect(credentials(`x = "ts_${key}"`)).toEqual([`ts_${key}`]);
    expect(credentials(`x = "tk_${key}"`)).toEqual([`tk_${key}`]);
    expect(credentials(`const k = "${"0f".repeat(32)}"`)).toEqual(["0f".repeat(32)]);
    expect(credentials(`clientSecret: "real-value"`)).toEqual(["real-value"]);
    expect(credentials(`const CLIENT_SECRET = "${DEMO_CLIENT_SECRET}"`)).toEqual([]);
    expect(credentials(`secretTypeId = ""`)).toEqual([]);
    // A prefix inside a longer name is no token, and 19 characters are too few.
    expect(credentials(`parts_${key} tk_${"a".repeat(19)}`)).toEqual([]);
  });

  it("logs nothing", () => {
    const sources = files(SRC).filter((f) => f.endsWith(".ts"));
    expect(sources.length).toBeGreaterThan(0);
    const calls = sources.filter((f) => readFileSync(f, "utf8").includes("console."));
    expect(calls.map((f) => relative(PKG, f))).toEqual([]);
  });
});
