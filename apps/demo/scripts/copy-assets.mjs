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
// With --check, it reads every .js file of dist/public/assets, the compiled
// page modules among them, after `tsc -p tsconfig.browser.json`. Each import
// must name a file of the build by a relative path. It prints
// `check-assets: PASS files=<n> imports=<m>`.
import { execFileSync } from "node:child_process";
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
// The scanner of the TypeScript parser in the workspace (typescript 7.0.2,
// pinned exactly). TypeScript 7 runs its full parser in a native binary, and
// these entries are the JavaScript tokenizer of that parser. They are marked
// unstable, so the tests hold each import form that the copy reads.
import { SyntaxKind as K } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";

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

const MAP_RE = /\n?\/\/# sourceMappingURL=\S+\s*$/;

function isNodeModule(spec) {
  return spec.startsWith("node:") || builtinModules.includes(spec.split("/")[0] ?? spec);
}

function posix(path) {
  return path.split("\\").join("/");
}

/** A token after which a slash divides. After any other token, a slash starts a regular expression. */
const EXPRESSION_END = new Set([
  K.Identifier,
  K.NumericLiteral,
  K.BigIntLiteral,
  K.StringLiteral,
  K.NoSubstitutionTemplateLiteral,
  K.TemplateTail,
  K.RegularExpressionLiteral,
  K.CloseParenToken,
  K.CloseBracketToken,
  K.CloseBraceToken,
  K.ThisKeyword,
  K.SuperKeyword,
  K.NullKeyword,
  K.TrueKeyword,
  K.FalseKeyword,
]);

/**
 * The module specifiers of `text`, each with the range of its string token
 * (quotes included). It reads a static import or export with `from`, a
 * side-effect import, and a dynamic import with one string. It throws on an
 * import that it cannot read, such as a dynamic import of an expression, so
 * no import passes unseen.
 */
export function importsOf(text, file) {
  const scanner = createScanner(true);
  scanner.setText(text);
  /** "{" for a brace, "${" for a template substitution. */
  const stack = [];
  let previous = K.Unknown;
  const scan = () => {
    let kind = scanner.scan();
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && !EXPRESSION_END.has(previous))
      kind = scanner.reScanSlashToken();
    if (kind === K.OpenBraceToken) stack.push("{");
    else if (kind === K.TemplateHead) stack.push("${");
    else if (kind === K.CloseBraceToken && stack.pop() === "${") {
      kind = scanner.reScanTemplateToken(false);
      if (kind === K.TemplateMiddle) stack.push("${");
    }
    if (scanner.isUnterminated())
      throw new Error(`${file}: an unterminated token at ${scanner.getTokenStart()}`);
    // The token in front, with no comment between. A dot there makes a property, as in `x.import`.
    const before = previous;
    previous = kind;
    return {
      kind,
      before,
      start: scanner.getTokenStart(),
      end: scanner.getTokenEnd(),
      value: scanner.getTokenValue(),
    };
  };
  let back = null;
  const take = () => {
    const token = back ?? scan();
    back = null;
    return token;
  };
  const unread = (what, at) => {
    throw new Error(`${file}: ${what} at ${at}, which the copy cannot read`);
  };
  /** Takes tokens up to `from` and a string; a semicolon or the end first is an import that the copy cannot read. */
  const fromClause = (at) => {
    for (let t = take(); ; t = take()) {
      if (t.kind === K.EndOfFile || t.kind === K.SemicolonToken) unread("an import or export", at);
      if (t.kind !== K.FromKeyword) continue;
      const spec = take();
      if (spec.kind === K.StringLiteral) return spec;
      back = spec;
    }
  };
  const found = [];
  for (let t = take(); t.kind !== K.EndOfFile; t = take()) {
    const member = t.before === K.DotToken || t.before === K.QuestionDotToken;
    if ((t.kind !== K.ImportKeyword && t.kind !== K.ExportKeyword) || member) continue;
    const next = take();
    if (next.kind === K.ColonToken || next.kind === K.DotToken) {
      // A property name (`import: 1`) or import.meta.
      back = next;
    } else if (t.kind === K.ImportKeyword && next.kind === K.OpenParenToken) {
      const arg = take();
      const close = take();
      const literal = arg.kind === K.StringLiteral || arg.kind === K.NoSubstitutionTemplateLiteral;
      if (!literal || (close.kind !== K.CloseParenToken && close.kind !== K.CommaToken))
        unread("a dynamic import of an expression", t.start);
      found.push(arg);
      back = close;
    } else if (t.kind === K.ImportKeyword && next.kind === K.StringLiteral) {
      found.push(next);
    } else if (t.kind === K.ImportKeyword || next.kind === K.AsteriskToken) {
      back = next;
      found.push(fromClause(t.start));
    } else if (next.kind === K.OpenBraceToken) {
      // export { a } is local; export { a } from "x" names a module.
      for (let m = take(); m.kind !== K.CloseBraceToken; m = take())
        if (m.kind === K.EndOfFile) unread("an export list", t.start);
      const after = take();
      if (after.kind === K.FromKeyword) {
        const spec = take();
        if (spec.kind !== K.StringLiteral) unread("an export from", t.start);
        found.push(spec);
      } else back = after;
    } else back = next;
  }
  return found.map((f) => ({ spec: f.value, start: f.start, end: f.end }));
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
    let text = readFileSync(file, "utf8").replace(MAP_RE, "\n");
    // From the end, so each range stays right after a rewrite before it.
    for (const { spec, start, end } of importsOf(text, file).reverse()) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        queue.push(resolve(dirname(file), spec));
        continue;
      }
      if (isNodeModule(spec))
        throw new Error(`${file} imports the Node module ${spec}, which a browser cannot load`);
      const path = rewrite(spec, out);
      if (path === null)
        throw new Error(`${file} imports the bare specifier ${spec}, which is not allowed`);
      text = `${text.slice(0, start)}${text[start]}${path}${text[start]}${text.slice(end)}`;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    written.push(out);
  }
}

/**
 * Reads each .js file under `dir` (dist/public/assets by default): every
 * import must name a file under `dir` by a relative path. The compiled page
 * modules are among the files, so a page module that imports a package name
 * fails here and not only in a browser. Answers the counts.
 */
/**
 * The static imports of each file, as the parser of V8 reads them. A child
 * Node with --experimental-vm-modules lists them by vm.SourceTextModule.
 * The token reader of importsOf can misread a slash after ")" or "}" as
 * division (Task 10 review, N1). So checkAssets holds its list to this one.
 */
const V8_LIST = `const vm = require("node:vm");
const fs = require("node:fs");
const out = {};
for (const f of JSON.parse(process.argv[1]))
  out[f] = new vm.SourceTextModule(fs.readFileSync(f, "utf8")).moduleRequests.map((r) => r.specifier);
process.stdout.write(JSON.stringify(out));`;

/** @param {string[]} files @returns {Record<string, string[]>} */
function v8Imports(files) {
  const args = ["--experimental-vm-modules", "--no-warnings", "-e", V8_LIST, JSON.stringify(files)];
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
}

export function checkAssets(dir = join(PKG, "dist/public/assets")) {
  let files = 0;
  let imports = 0;
  const all = readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(entry.parentPath, entry.name));
  const v8 = all.length === 0 ? {} : v8Imports(all);
  for (const file of all) {
    files++;
    const read = importsOf(readFileSync(file, "utf8"), file);
    for (const spec of v8[file] ?? [])
      if (!read.some((r) => r.spec === spec))
        throw new Error(`${file}: V8 reads the import ${spec}, and the copy does not`);
    for (const { spec } of read) {
      imports++;
      if (!spec.startsWith("./") && !spec.startsWith("../"))
        throw new Error(`${file} imports ${spec}, which is not a relative path`);
      const target = resolve(dirname(file), spec);
      if (relative(dir, target).startsWith("..") || !existsSync(target))
        throw new Error(`${file} imports ${spec}, which names no file of the build`);
    }
  }
  if (files === 0) throw new Error(`${dir} holds no .js file; run the build first`);
  return { files, imports };
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
  const check = process.argv.includes("--check");
  try {
    if (check) {
      const { files, imports } = checkAssets();
      console.log(`check-assets: PASS files=${files} imports=${imports}`);
    } else console.log(`copy-assets: PASS files=${copyAssets().length}`);
  } catch (error) {
    const name = check ? "check-assets" : "copy-assets";
    console.error(`${name}: FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
