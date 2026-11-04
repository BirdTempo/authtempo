import { describe, expect, it } from "vitest";

/**
 * Each write of an address onto an existing user proves that address (open
 * point 3 of the Task 2b review of plan 12p). Ruling 20 gives a session of a
 * user with no address the flag true. That holds only while no flow gives
 * such a user an unverified address. Else a claim of that address would find
 * a proved session of the claimant.
 *
 * The scan reads each call of the port's `update` in `src` whose model is
 * "user". When the type of its data has an `email` member, the same data
 * must set `emailVerified` to the literal `true`. `ALLOWED` names each other
 * write, with its reason.
 *
 * A create of a user is no write onto an existing user. No session of that
 * user exists before it, and `provedAtOpen` reads the new row. So the
 * anonymous upgrade, which creates the user of the address, needs no name.
 *
 * A port update whose model is not one literal can write a user too, such as
 * a store that forwards each call. `FORWARDS` names each one with its reason.
 * A new one fails this test until a person reads it and names it.
 *
 * The scan uses the TypeScript type checker, as `session-pass-sites.test.ts`
 * does. A member counts by the type of the data, so a spread or a variable
 * counts too. A cast does not hide the data: the scan reads the expression
 * inside it.
 */

/** The specifier in a constant keeps the compiler API out of core's typecheck. */
const TS_MODULE = "typescript-api";
const pathOf = (relative: string) =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);
const TSCONFIG = pathOf("../tsconfig.json");
const SRC = pathOf("../src/");
const PORT = pathOf("../src/storage/port.ts");

/** The writes of `email` with no `emailVerified: true`, by file: the count and the reason. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  "storage/conformance.ts": {
    count: 2,
    reason:
      "two cases test the unique key of an adapter's own test store; no flow and no session runs there",
  },
};

/** The port updates whose model is not one literal, by file: the count and the reason. */
const FORWARDS: Record<string, { count: number; reason: string }> = {
  "storage/conformance.ts": {
    count: 1,
    reason: "a case writes each model of the schema in a transaction that it undoes",
  },
  "storage/refresh-race-conformance.ts": {
    count: 3,
    reason: "the stores of the refresh race forward each update to the store under them",
  },
};

// biome-ignore lint/suspicious/noExplicitAny: the compiler API stays out of core's typecheck, as in body-reads.test.ts.
type Api = any;

interface UserWrite {
  /** `<file under src>:<line>`. */
  site: string;
  file: string;
  /** True when the type of the data has an `email` member. */
  email: boolean;
  /** True when the data sets `emailVerified` to the literal `true`. */
  verified: boolean;
  /** True when the checker cannot read the members of the data. */
  unread: boolean;
}

interface Scan {
  files: number;
  writes: UserWrite[];
  /** `<file under src>:<line>` of each port update whose model is not one literal. */
  forwards: string[];
}

/** The expression inside each cast, parenthesis, and non-null mark. */
function unwrap(ts: Api, node: Api): Api {
  let n = node;
  while (
    ts.isAsExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n)
  )
    n = n.expression;
  return n;
}

/** Each call of the port's `update` in `src`. */
function scan(ts: Api): Scan {
  const read = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, pathOf("../"));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const writes: UserWrite[] = [];
  const forwards: string[] = [];
  let files = 0;
  const literalOf = (type: Api): string | null =>
    type.isStringLiteral() ? (type.value as string) : null;
  const check = (file: Api, call: Api) => {
    if (!ts.isPropertyAccessExpression(call.expression)) return;
    if (call.expression.name.text !== "update") return;
    // Only the update of the storage port counts.
    const decl = checker.getResolvedSignature(call)?.getDeclaration();
    if (decl?.getSourceFile().fileName !== PORT) return;
    const { line } = file.getLineAndCharacterOfPosition(call.getStart());
    const name = file.fileName.slice(SRC.length);
    const site = `${name}:${line + 1}`;
    const model = checker.getTypeAtLocation(call.arguments[0]);
    const models: Api[] = model.isUnion() ? model.types : [model];
    const literals = models.map(literalOf);
    if (literals.some((m) => m === null) || models.length > 1) {
      // A union that leaves out "user" writes no user.
      if (literals.every((m) => m !== null) && !literals.includes("user")) return;
      forwards.push(site);
      return;
    }
    if (literals[0] !== "user") return;
    const data = unwrap(ts, call.arguments[2]);
    const type = checker.getTypeAtLocation(data);
    const flags = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;
    const parts: Api[] = type.isUnion() ? type.types : [type];
    const member = (part: Api, key: string) => checker.getPropertyOfType(part, key);
    // Each member of a union of data shapes answers on its own.
    const email = parts.some((part) => member(part, "email") !== undefined);
    const verified = parts.every((part) => {
      if (member(part, "email") === undefined) return true;
      const flag = member(part, "emailVerified");
      return (
        flag !== undefined &&
        checker.typeToString(checker.getTypeOfSymbolAtLocation(flag, data)) === "true"
      );
    });
    writes.push({ site, file: name, email, verified, unread: (type.flags & flags) !== 0 });
  };
  const visit = (file: Api, node: Api) => {
    if (ts.isCallExpression(node)) check(file, node);
    ts.forEachChild(node, (child: Api) => visit(file, child));
  };
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(SRC)) continue;
    files++;
    visit(file, file);
  }
  return { files, writes, forwards };
}

/** The count of each file in a list of `<file>:<line>` sites or of rows with a file. */
function perFile(sites: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const site of sites) {
    const file = site.slice(0, site.lastIndexOf(":"));
    out[file] = (out[file] ?? 0) + 1;
  }
  return out;
}

const counts = (named: Record<string, { count: number }>) =>
  Object.fromEntries(Object.entries(named).map(([file, v]) => [file, v.count]));

const compilerApi = async (): Promise<Api> =>
  ((await import(/* @vite-ignore */ TS_MODULE)) as { default: Api }).default;

describe("each write of an address onto a user (open point 3 of the Task 2b review of plan 12p)", () => {
  it("sets emailVerified true in the same data, or stands in ALLOWED with its reason", {
    timeout: 120_000,
  }, async () => {
    const { files, writes, forwards } = scan(await compilerApi());
    // The scan read the source, and it found the writes of the user row.
    expect(files).toBeGreaterThanOrEqual(200);
    expect(writes.filter((w) => w.file.startsWith("engine/")).length).toBeGreaterThanOrEqual(15);
    // No write hides its data from the checker.
    expect(writes.filter((w) => w.unread).map((w) => w.site)).toEqual([]);
    // Each write of an address that does not prove it has a name and a reason.
    const open = writes.filter((w) => w.email && !w.verified).map((w) => w.site);
    expect(perFile(open)).toEqual(counts(ALLOWED));
    // Each update that could write any model, the user too, has a name and a reason.
    expect(perFile(forwards)).toEqual(counts(FORWARDS));
    // It sees the two flows that write an address today: the confirm of a
    // change of address and the move of SCIM.
    const proved = writes.filter((w) => w.email && w.verified).map((w) => w.file);
    expect(proved).toEqual(
      expect.arrayContaining(["engine/email-change.ts", "engine/scim/users.ts"]),
    );
  });
});
