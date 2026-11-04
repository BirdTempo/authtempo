import { describe, expect, it } from "vitest";

/**
 * Each route of core passes the session that it holds (Low 2 of the Task 2
 * review of plan 12p). The scan reads each call in `src/http/routes` of an
 * engine function whose input has a `session` member. That call must pass a
 * `session`. A route that drops it reads the user row's rule, so a session
 * made before the proof of its address passes a gate it must fail.
 *
 * The type check holds a required `session`. It does not hold an optional
 * one, such as the one of `Caller`. So `OPTIONAL` names each engine function
 * with an optional `session` that a route calls. A new one fails this test
 * until a person names it here.
 *
 * The scan uses the TypeScript compiler API and its type checker, as
 * `body-reads.test.ts` does. A member counts by the type of the input, not
 * by its text.
 */

/** The specifier in a constant keeps the compiler API out of core's typecheck. */
const TS_MODULE = "typescript-api";
const pathOf = (relative: string) =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);
const TSCONFIG = pathOf("../tsconfig.json");
const ROUTES = pathOf("../src/http/routes/");
const ENGINE = pathOf("../src/engine/");

/**
 * The engine functions with an optional `session` that a route calls: the
 * closed flows of `Caller`, the token calls, and the slug check (plan 12p).
 */
const OPTIONAL = [
  "acceptInvitation",
  "addMember",
  "addTeamMember",
  "checkSlug",
  "createOrganization",
  "createTeam",
  "deleteOrganization",
  "deleteTeam",
  "inviteMember",
  "listApiTokens",
  "listInvitations",
  "listMembers",
  "listOrganizationTokens",
  "listOrganizations",
  "removeMember",
  "removeTeamMember",
  "revokeApiToken",
  "revokeInvitation",
  "revokeOrganizationToken",
  "updateApiToken",
  "updateMemberRole",
  "updateOrganization",
  "updateOrganizationToken",
  "updateTeam",
];

// biome-ignore lint/suspicious/noExplicitAny: the compiler API stays out of core's typecheck, as in body-reads.test.ts.
type Api = any;

interface SessionCall {
  /** `<file under src/http/routes>:<line>`. */
  site: string;
  /** The name of the engine function. */
  fn: string;
  /** True when the `session` member of the input is optional. */
  optional: boolean;
  /** True when the argument has a `session` member that can hold a value. */
  passes: boolean;
}

/** The name of a function declaration, or of the variable that holds a function. */
function nameOf(ts: Api, decl: Api): string {
  if (decl.name && ts.isIdentifier(decl.name)) return decl.name.text;
  if (decl.parent && ts.isVariableDeclaration(decl.parent)) return decl.parent.name.getText();
  return "(anonymous)";
}

/** Each route call of an engine function whose input has a `session` member. */
function sessionCalls(ts: Api): { files: number; calls: SessionCall[] } {
  const read = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, pathOf("../"));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const calls: SessionCall[] = [];
  let files = 0;
  const visit = (file: Api, node: Api) => {
    if (ts.isCallExpression(node)) check(file, node);
    ts.forEachChild(node, (child: Api) => visit(file, child));
  };
  const check = (file: Api, call: Api) => {
    const signature = checker.getResolvedSignature(call);
    const decl = signature?.getDeclaration();
    // Only a function of the engine counts.
    if (!decl?.getSourceFile().fileName.startsWith(ENGINE)) return;
    signature.getParameters().forEach((param: Api, i: number) => {
      const wanted = checker.getPropertyOfType(
        checker.getTypeOfSymbolAtLocation(param, call),
        "session",
      );
      if (!wanted) return;
      const arg = call.arguments[i];
      const given = arg
        ? checker.getPropertyOfType(checker.getTypeAtLocation(arg), "session")
        : null;
      // `session: undefined` names the member and passes nothing.
      const passes =
        given != null &&
        (checker.getTypeOfSymbolAtLocation(given, arg).flags & ts.TypeFlags.Undefined) === 0;
      const { line } = file.getLineAndCharacterOfPosition(call.getStart());
      calls.push({
        site: `${file.fileName.slice(ROUTES.length)}:${line + 1}`,
        fn: nameOf(ts, decl),
        optional: (wanted.flags & ts.SymbolFlags.Optional) !== 0,
        passes,
      });
    });
  };
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(ROUTES)) continue;
    files++;
    visit(file, file);
  }
  return { files, calls };
}

const compilerApi = async (): Promise<Api> =>
  ((await import(/* @vite-ignore */ TS_MODULE)) as { default: Api }).default;

describe("the session of each route call (Low 2 of the Task 2 review of plan 12p)", () => {
  it("passes the session at each route call of an engine function that takes one", {
    timeout: 120_000,
  }, async () => {
    const { files, calls } = sessionCalls(await compilerApi());
    // The scan read the route files, and it found the calls.
    expect(files).toBeGreaterThanOrEqual(25);
    expect(calls.length).toBeGreaterThan(OPTIONAL.length);
    expect(calls.filter((c) => !c.passes).map((c) => `${c.site} ${c.fn}`)).toEqual([]);
    // Each function with an optional session has a name here, and each name has a call.
    const optional = [...new Set(calls.filter((c) => c.optional).map((c) => c.fn))].sort();
    expect(optional).toEqual([...OPTIONAL].sort());
  });
});
