// The raw request body reads of a package (ruling 46 Minor 1 of the 12j
// lane). Each body read must go through the capped reader of core, so a
// read of `json`, `text`, `formData`, `arrayBuffer`, `blob`, `bytes`, or
// `body` on a Request, a clone of one too, fails the source scan of core
// and of compat-better-auth outside the reader files that each one allows.
// The scan uses the TypeScript compiler API and its type checker, not a
// regular expression (lessons of 2026-10-09): only a receiver whose type is
// Request counts, so a read of a Response passes. Ruling 51 Low 2 adds the
// forms that the re-review planted: an intersection with Request, an
// element access with a literal name, any access of a member and not only a
// call (`.bind`, `.call`), a parameter pattern, a nested pattern, and an
// assignment pattern. A value typed `any` or by a structural type with no
// Request in it stays out of reach of a type check.

import { dirname, relative } from "node:path";

/** The members of a Request that read its body. `body` is a property; the others are calls. */
export const BODY_MEMBERS = ["json", "text", "formData", "arrayBuffer", "blob", "bytes", "body"];

/**
 * @param {any} ts the compiler API (typescript 6).
 * @param {string} tsconfig the absolute path of the tsconfig of the package.
 * @param {string[]} [files] the files to read instead of those of the tsconfig.
 * @returns {{ files: number, reads: string[] }} each read as "<file>:<line> <receiver>.<member>".
 */
export function rawBodyReads(ts, tsconfig, files) {
  const root = dirname(tsconfig);
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const program = ts.createProgram(files ?? parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  /** @param {any} type */
  const isRequest = (type) =>
    type.isUnion() || type.isIntersection()
      ? type.types.some(isRequest)
      : (type.getSymbol() ?? type.aliasSymbol)?.getName() === "Request";
  /**
   * The member name of a property access, or of an element access with a literal name, else null.
   * @param {any} node
   */
  const memberOf = (node) => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      return node.argumentExpression.text;
    return null;
  };
  /**
   * The name of a member in a pattern: `body`, `body: alias`, or `"body": alias`, else null.
   * @param {any} name
   */
  const nameOf = (name) =>
    ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
  /** @type {string[]} */
  const reads = [];
  let count = 0;
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || relative(root, source.fileName).startsWith("..")) continue;
    if (source.fileName.includes("/node_modules/")) continue;
    count += 1;
    const where = (/** @type {any} */ node) =>
      `${relative(root, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    /** @param {any} node */
    const visit = (node) => {
      // Any access of a member, a call or not: `request.json()`, `request["text"]()`, `request.json.bind`.
      const member = memberOf(node);
      if (
        member !== null &&
        BODY_MEMBERS.includes(member) &&
        isRequest(checker.getTypeAtLocation(node.expression))
      )
        reads.push(`${where(node)} ${node.expression.getText()}.${member}`);
      // A pattern of a variable, of a parameter, or inside another pattern:
      // `const { body } = request`, `({ body }: Request) => body`, `const { request: { body } } = ctx`.
      if (ts.isObjectBindingPattern(node)) {
        const type = checker.getTypeAtLocation(node);
        const from =
          ts.isVariableDeclaration(node.parent) && node.parent.initializer
            ? `= ${node.parent.initializer.getText()}`
            : `of ${checker.typeToString(type)}`;
        for (const element of node.elements) {
          const name = nameOf(element.propertyName ?? element.name);
          if (name !== null && BODY_MEMBERS.includes(name) && isRequest(type))
            reads.push(`${where(element)} { ${name} } ${from}`);
        }
      }
      // An assignment pattern: `({ body } = request)`.
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isObjectLiteralExpression(node.left) &&
        isRequest(checker.getTypeAtLocation(node.right))
      )
        for (const property of node.left.properties) {
          const name = property.name === undefined ? null : nameOf(property.name);
          if (name !== null && BODY_MEMBERS.includes(name))
            reads.push(`${where(property)} { ${name} } = ${node.right.getText()}`);
        }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files: count, reads };
}
