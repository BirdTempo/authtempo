import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED, checkAssets, copyAssets, importsOf } from "../../scripts/copy-assets.mjs";

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

  it("allows the access, the errors, and the routes entries of core, and no other", () => {
    expect(ALLOWED).toEqual({
      "@authtempo/core/access": "access.js",
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
      // The start link of client.sso reads the segment rule too (plan 12d Task 13).
      'import { PARAM_SEGMENT_RE, PROVIDER_NAME_RE } from "../core/routes.js";',
    );
    for (const name of files(client))
      expect(readFileSync(join(client, name), "utf8"), name).not.toContain("@authtempo/");
    expect(files(join(dir, "assets/core"))).toEqual([
      "access.js",
      "errors.js",
      "http/anchors.js",
      "http/redirect.js",
      "http/route-key.js",
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

/**
 * A client build of one file in a new folder. The test writes it here, not
 * in fixtures/, because the formatter would add the spaces of a minified import.
 */
function clientOf(source: string, more: Record<string, string> = {}): string {
  const dir = out();
  for (const [name, text] of Object.entries({ "index.js": source, ...more }))
    writeFileSync(join(dir, name), text);
  return join(dir, "index.js");
}

describe("the import reader of copy-assets.mjs", () => {
  it("follows a minified import, a side-effect import, a dynamic import, and two re-exports", () => {
    const client = clientOf(
      'import{a}from"./a.js";import"./b.js";const c=await import("./c.js");export*from"./d.js";export{e}from"./e.js";',
      Object.fromEntries(["a", "b", "c", "d", "e"].map((n) => [`${n}.js`, `export const ${n}=1;`])),
    );
    const dir = out();
    run({ out: dir, client });
    expect(files(join(dir, "assets/client"))).toEqual([
      "a.js",
      "b.js",
      "c.js",
      "d.js",
      "e.js",
      "index.js",
    ]);
  });

  it("rewrites a minified import of the core errors", () => {
    const dir = out();
    run({
      out: dir,
      client: clientOf('import{ERRORS}from"@authtempo/core/errors";export{ERRORS};'),
    });
    expect(readFileSync(join(dir, "assets/client/index.js"), "utf8")).toBe(
      'import{ERRORS}from"../core/errors.js";export{ERRORS};',
    );
  });

  it("fails on a bare specifier in each import form", () => {
    const forms = [
      'import{a}from"@authtempo/core";',
      'import"@authtempo/core";',
      'const m=await import("@authtempo/core");',
      "const m=await import(`@authtempo/core`);",
      'export*from"@authtempo/core";',
      'export{a}from"@authtempo/core";',
    ];
    for (const form of forms) {
      const client = clientOf(form);
      expect(() => run({ out: out(), client }), form).toThrow(
        `${client} imports the bare specifier @authtempo/core, which is not allowed`,
      );
    }
  });

  it("fails closed on an import that it cannot read", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text is source for the reader, so ${x} must stay as typed.
    for (const form of ["const m=await import(`./${x}.js`);", "const m=await import(name);"]) {
      const client = clientOf(form);
      expect(() => run({ out: out(), client }), form).toThrow(
        `${client}: a dynamic import of an expression at 14, which the copy cannot read`,
      );
    }
  });

  it("reads no import in a comment, a string, a regular expression, or a property", () => {
    const text = [
      '// import "@x/comment";',
      "/* export * from '@x/block'; */",
      "const s = \"import '@x/string'\";",
      'const t = `export * from "@x/template"`;',
      'const r = /import "@x\\/regex"/;',
      "const q = a / 2 / b;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text is source for the reader, so ${b} must stay as typed.
      'const w = `a${b}import "@x/substitution"`;',
      "const o = { import: 1, export: 2 };",
      "o.import(1); o?.export;",
      "const u = import.meta.url;",
      "export const z = 1;",
      "export { s, t };",
    ].join("\n");
    expect(importsOf(text, "probe.js")).toEqual([]);
  });

  it("runs the asset check after the page compile in each script that writes the assets", () => {
    const scripts = (
      JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    // Ruling 44: test and typecheck write nothing; test/node/scripts.test.ts holds them.
    for (const name of ["build", "dev"])
      expect(scripts[name], name).toContain(
        "node scripts/copy-assets.mjs && tsc -p tsconfig.browser.json && node scripts/copy-assets.mjs --check",
      );
  });

  it("checks each compiled page module and each copy of the build", () => {
    const assets = join(PKG, "dist/public/assets");
    const js = files(assets).filter((n) => n.endsWith(".js"));
    expect(js.filter((n) => n.startsWith("js/")).length).toBe(11);
    const { files: read, imports } = checkAssets(assets);
    expect(read).toBe(js.length);
    expect(imports).toBeGreaterThan(30);
  });

  it("fails a static import that V8 reads and the token reader misses (Task 10 review, N1)", () => {
    const dir = out();
    // After "}" the reader takes the slash as division, so the quote in the regular
    // expression opens a string that hides the import. V8 reads the import, and the
    // message names a miss of the reader only.
    const probe = 'if (globalThis.a) {}\n/\'/.test("x");import "node:fs";//\'\n';
    writeFileSync(join(dir, "page.js"), probe);
    expect(() => checkAssets(dir)).toThrow(
      `${join(dir, "page.js")}: V8 reads the import node:fs, and the copy does not`,
    );
  });

  it("fails a compiled module that imports a package name or a missing file", () => {
    const dir = out();
    mkdirSync(join(dir, "js"));
    writeFileSync(join(dir, "js/page.js"), 'import { createClient } from "@authtempo/client";\n');
    expect(() => checkAssets(dir)).toThrow(
      `${join(dir, "js/page.js")} imports @authtempo/client, which is not a relative path`,
    );
    writeFileSync(join(dir, "js/page.js"), 'import { createClient } from "../client/index.js";\n');
    expect(() => checkAssets(dir)).toThrow(
      `${join(dir, "js/page.js")} imports ../client/index.js, which names no file of the build`,
    );
  });
});
