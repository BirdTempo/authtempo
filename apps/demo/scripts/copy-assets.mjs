// The assets of the demo pages (plan 11b Task 10, ruling 34 of the lane).
// It writes dist/public from the build of the repo, never from a request:
// - public/ of this package (_headers and assets/demo.css), as it is;
// - the one token file of the site to assets/tokens.css, and the five fonts
//   that it names to fonts/ (ruling 6), with their license files;
// - packages/client/dist/index.js and every file that it reaches by a
//   relative import to assets/client/;
// - the entry of each allowed core specifier with its relative imports to
//   assets/core/, and each import of that specifier in a copied file becomes
//   the relative path of the copy;
// - packages/core/dist/primitives/totp.js with its relative imports (deviation 4).
// Any other bare specifier, or a Node module, stops the copy with exit 1 and
// the file and the specifier. It prints `copy-assets: PASS files=<n>`.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const REPO = resolve(PKG, "../..");

/**
 * The bare specifiers that a copied file may import, each with the file of
 * core that it names. The client imports values from both (ruling 34).
 * @type {Readonly<Record<string, string>>}
 */
export const ALLOWED = Object.freeze({
  "@authtempo/core/errors": "errors.js",
  "@authtempo/core/routes": "routes.js",
});

/** The default sources: the build of this tree. */
export const SOURCES = Object.freeze({
  publicDir: join(PKG, "public"),
  tokens: join(REPO, "apps/site/src/styles/tokens.css"),
  fonts: join(REPO, "apps/site/public/fonts"),
  client: join(REPO, "packages/client/dist/index.js"),
  coreDist: join(REPO, "packages/core/dist"),
});

// A static import or export with "from", a side-effect import, and a dynamic import.
const SPECIFIER_RE =
  /(\b(?:import|export)\s[^;]*?\sfrom\s*)(["'])([^"']+)\2|(\bimport\s*)(["'])([^"']+)\5|(\bimport\s*\(\s*)(["'])([^"']+)\8/g;
const MAP_RE = /\n?\/\/# sourceMappingURL=\S+\s*$/;

function isNodeModule(spec) {
  return spec.startsWith("node:") || builtinModules.includes(spec.split("/")[0] ?? spec);
}

function posix(path) {
  return path.split("\\").join("/");
}

/**
 * Copies `entry` and every file that it reaches by a relative import into
 * `outDir`, with the layout of `srcRoot`. `rewrite(spec, outFile)` answers the
 * relative path of an allowed bare specifier, or null. Each file is read once.
 * The source map comment goes, because no map is copied.
 */
function copyGraph(entry, srcRoot, outDir, rewrite, written) {
  const queue = [resolve(entry)];
  const seen = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const name = relative(srcRoot, file);
    if (name.startsWith("..")) throw new Error(`${file} is outside ${srcRoot}`);
    if (!existsSync(file)) throw new Error(`${file} is missing; build its package first`);
    const out = join(outDir, name);
    const source = readFileSync(file, "utf8").replace(MAP_RE, "\n");
    const text = source.replace(SPECIFIER_RE, (whole, ...g) => {
      const head = g[0] ?? g[3] ?? g[6];
      const quote = g[1] ?? g[4] ?? g[7];
      const spec = g[2] ?? g[5] ?? g[8];
      if (spec.startsWith("./") || spec.startsWith("../")) {
        queue.push(resolve(dirname(file), spec));
        return whole;
      }
      if (isNodeModule(spec))
        throw new Error(`${file} imports the Node module ${spec}, which a browser cannot load`);
      const path = rewrite(spec, out);
      if (path === null)
        throw new Error(`${file} imports the bare specifier ${spec}, which is not allowed`);
      return `${head}${quote}${path}${quote}`;
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    written.push(out);
  }
}

/** Copies each file of `from` to `to`, and answers the files written. */
function copyTree(from, to, written) {
  for (const entry of readdirSync(from, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const src = join(entry.parentPath, entry.name);
    const out = join(to, relative(from, src));
    mkdirSync(dirname(out), { recursive: true });
    cpSync(src, out);
    written.push(out);
  }
}

/**
 * Writes the assets into `out` (dist/public by default), after it deletes
 * `out`, so no file of an older build stays. Answers the files written.
 */
export function copyAssets(options = {}) {
  const src = { ...SOURCES, ...options };
  const out = options.out ?? join(PKG, "dist/public");
  const written = [];
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  copyTree(src.publicDir, out, written);

  const tokens = readFileSync(src.tokens, "utf8");
  const tokensOut = join(out, "assets/tokens.css");
  mkdirSync(dirname(tokensOut), { recursive: true });
  writeFileSync(tokensOut, tokens);
  written.push(tokensOut);
  // Each url() of the token file names a font of the site (ruling 6).
  for (const m of tokens.matchAll(/url\(\s*["']?\/fonts\/([^"')]+)["']?\s*\)/g)) {
    const name = m[1] ?? "";
    const fontOut = join(out, "fonts", name);
    mkdirSync(dirname(fontOut), { recursive: true });
    cpSync(join(src.fonts, name), fontOut);
    written.push(fontOut);
  }
  // The license files go with the fonts: the SIL Open Font License of both fonts needs its text with each copy.
  for (const name of readdirSync(src.fonts).filter((n) => n.endsWith(".txt"))) {
    cpSync(join(src.fonts, name), join(out, "fonts", name));
    written.push(join(out, "fonts", name));
  }

  const coreOut = join(out, "assets/core");
  const toCore = (spec, outFile) => {
    const target = ALLOWED[spec];
    if (target === undefined) return null;
    const path = posix(relative(dirname(outFile), join(coreOut, target)));
    return path.startsWith(".") ? path : `./${path}`;
  };
  copyGraph(src.client, dirname(src.client), join(out, "assets/client"), toCore, written);
  for (const target of Object.values(ALLOWED))
    copyGraph(join(src.coreDist, target), src.coreDist, coreOut, toCore, written);
  copyGraph(join(src.coreDist, "primitives/totp.js"), src.coreDist, coreOut, toCore, written);
  return [...new Set(written)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const files = copyAssets();
    console.log(`copy-assets: PASS files=${files.length}`);
  } catch (error) {
    console.error(`copy-assets: FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
