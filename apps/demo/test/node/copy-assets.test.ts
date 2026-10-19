import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED, copyAssets } from "../../scripts/copy-assets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "../..");
const REPO = resolve(PKG, "../..");
const run = copyAssets;

const outs: string[] = [];
function out(): string {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-demo-assets-"));
  outs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of outs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The files under `dir`, as sorted paths relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/** Each specifier of a static import or export in `source`. */
function specifiers(source: string): string[] {
  return [...source.matchAll(/\b(?:import|export)\s[^;]*?\sfrom\s*"([^"]+)"/g)].map(
    (m) => m[1] ?? "",
  );
}

describe("copy-assets.mjs", () => {
  it("copies the client with its relative imports", () => {
    const dir = out();
    run({ out: dir });
    const client = join(dir, "assets/client");
    expect(files(client)).toEqual([
      "calls.js",
      "client.js",
      "error-text.js",
      "index.js",
      "redirect-error.js",
      "result.js",
      "store.js",
      "transport.js",
      "webauthn.js",
    ]);
    // Each relative import of each copy names a copied file, and no bare specifier is left.
    let imports = 0;
    for (const name of files(client)) {
      const file = join(client, name);
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        expect(spec, `${name} imports ${spec}`).toMatch(/^\.\.?\//);
        expect(existsSync(resolve(dirname(file), spec)), `${name} imports ${spec}`).toBe(true);
        imports++;
      }
    }
    expect(imports).toBeGreaterThan(20);
  });

  it("allows the errors and the routes entries of core, and no other", () => {
    expect(ALLOWED).toEqual({
      "@authtempo/core/errors": "errors.js",
      "@authtempo/core/routes": "routes.js",
    });
  });

  it("rewrites the core errors specifier", () => {
    const dir = out();
    run({ out: dir });
    const client = join(dir, "assets/client");
    const source = readFileSync(join(REPO, "packages/client/dist/transport.js"), "utf8");
    expect(source).toContain('from "@authtempo/core/errors"');
    const copy = readFileSync(join(client, "transport.js"), "utf8");
    expect(copy).toContain('import { ERRORS } from "../core/errors.js";');
    expect(readFileSync(join(client, "client.js"), "utf8")).toContain(
      'import { PROVIDER_NAME_RE } from "../core/routes.js";',
    );
    for (const name of files(client))
      expect(readFileSync(join(client, name), "utf8"), name).not.toContain("@authtempo/");
    expect(files(join(dir, "assets/core"))).toEqual([
      "errors.js",
      "http/anchors.js",
      "http/redirect.js",
      "http/route-list.js",
      "primitives/crypto.js",
      "primitives/totp.js",
      "routes.js",
      "social/provider.js",
    ]);
  });

  it("fails on another bare specifier", () => {
    const fixture = join(HERE, "fixtures/bare/index.js");
    expect(() => run({ out: out(), client: fixture })).toThrow(
      `${join(HERE, "fixtures/bare/inner.js")} imports the bare specifier @authtempo/core, which is not allowed`,
    );
  });

  it("fails on a Node module, with or without the node: prefix", () => {
    for (const [name, spec] of [
      ["node-prefix", "node:fs"],
      ["node-builtin", "fs"],
    ] as const) {
      const fixture = join(HERE, `fixtures/${name}/index.js`);
      expect(() => run({ out: out(), client: fixture })).toThrow(
        `${fixture} imports the Node module ${spec}, which a browser cannot load`,
      );
    }
  });

  it("copies the TOTP primitive with crypto.js", () => {
    const dir = out();
    run({ out: dir });
    const totp = readFileSync(join(dir, "assets/core/primitives/totp.js"), "utf8");
    expect(totp).toContain('import { constantTimeEqual } from "./crypto.js";');
    expect(totp).toContain("export function totpCode(");
    expect(totp).toContain("export function base32Decode(");
    expect(existsSync(join(dir, "assets/core/primitives/crypto.js"))).toBe(true);
  });

  it("copies tokens.css and each font that it names", () => {
    const dir = out();
    run({ out: dir });
    const copy = readFileSync(join(dir, "assets/tokens.css"), "utf8");
    expect(copy).toBe(readFileSync(join(REPO, "apps/site/src/styles/tokens.css"), "utf8"));
    const urls = [...copy.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1] ?? "");
    expect(urls).toEqual([
      "/fonts/inter-400.woff2",
      "/fonts/inter-500.woff2",
      "/fonts/inter-600.woff2",
      "/fonts/jetbrains-mono-400.woff2",
      "/fonts/jetbrains-mono-500.woff2",
    ]);
    for (const url of urls) {
      const copied = join(dir, url);
      expect(existsSync(copied), url).toBe(true);
      expect(readFileSync(copied).equals(readFileSync(join(REPO, "apps/site/public", url)))).toBe(
        true,
      );
    }
    expect(files(join(dir, "fonts")).filter((n) => n.endsWith(".txt"))).toEqual([
      "Inter-LICENSE.txt",
      "JetBrainsMono-OFL.txt",
    ]);
  });

  it("copies public/ of the package and deletes the files of an older build", () => {
    const dir = out();
    writeFileSync(join(dir, "stale.js"), "old");
    const written = run({ out: dir });
    expect(existsSync(join(dir, "stale.js"))).toBe(false);
    expect(readFileSync(join(dir, "_headers"), "utf8")).toBe(
      readFileSync(join(PKG, "public/_headers"), "utf8"),
    );
    expect(existsSync(join(dir, "assets/demo.css"))).toBe(true);
    // The count of the PASS line is the count of the files in the folder.
    expect(written.length).toBe(files(dir).length);
  });
});
