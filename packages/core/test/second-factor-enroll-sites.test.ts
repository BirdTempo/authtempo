import { describe, expect, it } from "vitest";
// Core's tests have no Node types, so the file comes in as Vite's ?raw text (test/raw.d.ts).
import manifestText from "../package.json?raw";

/**
 * Each enroll site of a second factor reads a proof helper before its write.
 * This is open point 2 of the Task 3 review of plan 12p (ruling 28).
 *
 * The rule: no claimant holds a factor. The challenge verify of a second
 * factor guards only its own row, and the claim deletes no factor row. A
 * challenge from a sign-in before the claim, verified after it, opens a
 * proved session. That is safe only while no claimant can enroll a factor.
 * So each site that turns a factor on reads `provedAccount` or
 * `provedAddress` before its write. A claimant's session is never proved, so
 * each site refuses it.
 *
 * A factor write is a create of a `totp` or a `secondFactor` row. It is also
 * an update that sets `enabledAt` of a `totp` row, or `methods` of a
 * `secondFactor` row. A write counts by the literal model of its first
 * argument. The scan leaves out the conformance suite of the adapters, which
 * writes test rows on the adapter under test. No flow calls it.
 *
 * The scan takes the function of each write. A callback that a call gets
 * counts as part of the function around it, such as a transaction body.
 * When that function reads no helper before the write, the scan goes to
 * each caller and checks the helper before the call. A function with no
 * gate, no caller, and no name in `REMOVES` is a way to a factor with no
 * proof, and the test fails.
 *
 * The scan uses the TypeScript compiler API and its type checker, as
 * `session-pass-sites.test.ts` does. A call counts by the function that it
 * resolves to.
 */

/** The specifier in a constant keeps the compiler API out of core's typecheck. */
const TS_MODULE = "typescript-api";
const pathOf = (relative: string) =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);
const ROOT = pathOf("../");
const TSCONFIG = pathOf("../tsconfig.json");
const SRC = pathOf("../src/");
const PORT = pathOf("../src/storage/port.ts");
const ADDRESS = pathOf("../src/engine/address.ts");
const CONFORMANCE = pathOf("../src/storage/conformance.ts");

const FACTOR_MODELS = new Set(["totp", "secondFactor"]);
const WRITES = new Set(["create", "createMany", "update"]);
const GATES = new Set(["provedAccount", "provedAddress"]);

/** The functions with a factor write of their own. A new one fails this test until a person names it here. */
const WRITERS = ["addMethod", "enableTotp", "removeMethod", "setupTotp"];

/** The writers that only take a method away. The last method deletes the row. They need no gate. */
const REMOVES = ["removeMethod"];

/** The writers with no gate of their own. Each of their callers reads a helper before the call. */
const INNER = ["addMethod", "enableMethod"];

/**
 * Each enroll site and the helper that it reads. The claim-rule page names
 * these groups: TOTP and the passkey method read `provedAccount`, and the
 * email method reads `provedAddress`.
 */
const SITES: Record<string, string[]> = {
  enableEmailMethod: ["provedAddress"],
  enablePasskeyMethod: ["provedAccount"],
  enableTotp: ["provedAccount"],
  setupTotp: ["provedAccount"],
};

// biome-ignore lint/suspicious/noExplicitAny: the compiler API stays out of core's typecheck, as in session-pass-sites.test.ts.
type Api = any;

interface Scan {
  /** The source files of `src` that the scan read. */
  files: number;
  /** Each factor write, as `<file under src>:<line> <function>`. */
  writes: string[];
  /** The names of the functions with a factor write of their own. */
  writers: string[];
  /** Each enroll site and the helpers that it reads before its write or call. */
  sites: Record<string, string[]>;
  /** The writers with no gate of their own. */
  inner: string[];
  /** Each way to a factor write with no gate: a function with no caller. */
  roots: string[];
  /** Each use of an inner writer that is not a call: an export, or a value. */
  escapes: string[];
  /** Each inner writer that an entry of the package exports. */
  exported: string[];
  /** Each import that renames a writer or a helper, so that a scan by name would miss it. */
  renamed: string[];
}

/** The name of a function declaration, a method, or the variable that holds a function. */
function nameOf(ts: Api, fn: Api): string {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) return fn.name.text;
  if (fn.parent && ts.isVariableDeclaration(fn.parent)) return fn.parent.name.getText();
  if (fn.parent && ts.isPropertyAssignment(fn.parent)) return fn.parent.name.getText();
  return "(anonymous)";
}

/** The text of a call's callee: `f` of `f()`, `create` of `tx.create()`. */
function calleeName(ts: Api, call: Api): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

/**
 * The function that owns a node. A function or an arrow that is an argument
 * of a call is a callback, such as a transaction body. Its owner is the
 * function around that call.
 */
function ownerOf(ts: Api, node: Api): Api | null {
  for (let p = node.parent; p; p = p.parent) {
    if (!ts.isFunctionLike(p) || !p.body) continue;
    const callback =
      (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
      p.parent &&
      ts.isCallExpression(p.parent) &&
      p.parent.arguments.includes(p);
    if (!callback) return p;
  }
  return null;
}

/** The string literals that a type can hold: one literal, or each literal of a union. */
function literalsOf(type: Api): string[] {
  if (type.isStringLiteral()) return [type.value];
  if (type.isUnion()) return type.types.flatMap((t: Api) => (t.isStringLiteral() ? [t.value] : []));
  return [];
}

function scan(ts: Api): Scan {
  const read = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter((f: Api) => f.fileName.startsWith(SRC));
  const siteOf = (node: Api) => {
    const file = node.getSourceFile();
    const { line } = file.getLineAndCharacterOfPosition(node.getStart());
    return `${file.fileName.slice(SRC.length)}:${line + 1}`;
  };
  const declOf = (call: Api) => checker.getResolvedSignature(call)?.getDeclaration() ?? null;
  // Every call of `src` by the text of its callee, and every identifier by its text.
  const calls = new Map<string, Api[]>();
  const names = new Map<string, Api[]>();
  const renamed: string[] = [];
  const watched = new Set([...WRITERS, ...INNER, ...Object.keys(SITES), ...GATES]);
  const visit = (node: Api) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(ts, node);
      if (name !== null) calls.set(name, [...(calls.get(name) ?? []), node]);
    }
    if (ts.isIdentifier(node)) names.set(node.text, [...(names.get(node.text) ?? []), node]);
    if (ts.isImportSpecifier(node) && node.propertyName && watched.has(node.propertyName.text))
      renamed.push(`${siteOf(node)} ${node.propertyName.text} as ${node.name.text}`);
    ts.forEachChild(node, visit);
  };
  for (const file of sources) visit(file);

  // The factor writes: a storage call of the port, on a factor model, that turns a factor on.
  const writes: { call: Api; fn: Api | null }[] = [];
  for (const verb of WRITES) {
    for (const call of calls.get(verb) ?? []) {
      if (call.getSourceFile().fileName === CONFORMANCE) continue;
      if (declOf(call)?.getSourceFile().fileName !== PORT) continue;
      const [model, , data] = call.arguments;
      if (!model) continue;
      if (!literalsOf(checker.getTypeAtLocation(model)).some((m) => FACTOR_MODELS.has(m))) continue;
      if (verb === "update") {
        const type = data ? checker.getTypeAtLocation(data) : null;
        const on = ["enabledAt", "methods"].some((f) => type && checker.getPropertyOfType(type, f));
        if (!on) continue;
      }
      writes.push({ call, fn: ownerOf(ts, call) });
    }
  }

  /** The gates in `fn` before `at`: the calls of the two helpers of address.ts. */
  const gatesBefore = (fn: Api, at: number): string[] =>
    [...GATES].filter((gate) =>
      (calls.get(gate) ?? []).some(
        (call) =>
          call.getStart() < at &&
          ownerOf(ts, call) === fn &&
          declOf(call)?.getSourceFile().fileName === ADDRESS,
      ),
    );
  const symbolOf = (node: Api) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  };

  const sites: Record<string, Set<string>> = {};
  const inner = new Map<Api, string>();
  const roots: string[] = [];
  const escapes: string[] = [];
  const queue = writes.map((w) => ({ fn: w.fn, at: w.call.getStart() }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { fn, at } = next;
    if (!fn) {
      roots.push("(top level)");
      continue;
    }
    const name = nameOf(ts, fn);
    const gates = gatesBefore(fn, at);
    if (gates.length > 0) {
      sites[name] = new Set([...(sites[name] ?? []), ...gates]);
      continue;
    }
    if (REMOVES.includes(name) || inner.has(fn)) continue;
    inner.set(fn, name);
    const callers = (calls.get(name) ?? []).filter((call) => declOf(call) === fn);
    if (callers.length === 0) roots.push(`${siteOf(fn)} ${name}`);
    for (const call of callers) queue.push({ fn: ownerOf(ts, call), at: call.getStart() });
    // A use that is not a call makes the writer reachable with no gate of core's.
    for (const id of names.get(name) ?? []) {
      const parent = id.parent;
      if (parent === fn || ts.isImportSpecifier(parent)) continue;
      if (ts.isCallExpression(parent) && parent.expression === id) continue;
      if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
        if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent) continue;
      }
      if (symbolOf(id)?.declarations?.includes(fn)) escapes.push(`${siteOf(id)} ${name}`);
    }
  }

  // An entry of the package that exports an inner writer gives it to an app with no gate.
  const exported: string[] = [];
  const pkg = JSON.parse(manifestText) as {
    exports: Record<string, { default: string }>;
  };
  for (const [entry, target] of Object.entries(pkg.exports)) {
    const file = program.getSourceFile(
      `${SRC}${target.default.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts")}`,
    );
    const module = file ? checker.getSymbolAtLocation(file) : null;
    if (!module) continue;
    for (const symbol of checker.getExportsOfModule(module)) {
      const real = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      for (const [fn, name] of inner)
        if (real.declarations?.includes(fn)) exported.push(`${entry} ${name}`);
    }
  }

  return {
    files: sources.length,
    writes: writes.map((w) => `${siteOf(w.call)} ${w.fn ? nameOf(ts, w.fn) : "(top level)"}`),
    writers: [...new Set(writes.map((w) => (w.fn ? nameOf(ts, w.fn) : "(top level)")))].sort(),
    sites: Object.fromEntries(
      Object.entries(sites)
        .map(([name, gates]) => [name, [...gates].sort()] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    inner: [...new Set(inner.values())].sort(),
    roots,
    escapes,
    exported,
    renamed,
  };
}

const compilerApi = async (): Promise<Api> =>
  ((await import(/* @vite-ignore */ TS_MODULE)) as { default: Api }).default;

describe("the enroll sites of a second factor (open point 2 of the Task 3 review of plan 12p)", () => {
  it("reads provedAccount or provedAddress before each write that turns a factor on", {
    timeout: 120_000,
  }, async () => {
    const found = scan(await compilerApi());
    // The scan read the source, and it found the writes.
    expect(found.files).toBeGreaterThanOrEqual(150);
    expect(found.writes.length).toBeGreaterThanOrEqual(WRITERS.length);
    expect(found.writers).toEqual([...WRITERS].sort());
    expect(found.renamed).toEqual([]);
    // Each way to a factor write passes a gate: no root, no escape, no export.
    expect(found.roots).toEqual([]);
    expect(found.escapes).toEqual([]);
    expect(found.exported).toEqual([]);
    expect(found.inner).toEqual([...INNER].sort());
    expect(found.sites).toEqual(SITES);
  });
});
