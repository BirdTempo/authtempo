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
// Request in it stays out of reach of a type check. Ruling 59 Low 3 adds
// the forms of the next re-review: a type parameter that extends Request,
// a class or an interface that extends it, a computed name with a literal
// in a pattern, an element access by a value of a string literal type, and
// `Reflect.get` with a literal name.

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
  /**
   * True for Request, a union or an intersection with it, a type parameter
   * that extends it, and a class or an interface that extends it.
   * @param {any} type
   * @param {Set<any>} [seen] the types on the path, so a cycle of bases ends.
   * @returns {boolean}
   */
  const isRequest = (type, seen = new Set()) => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isTypeParameter()) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint !== undefined && isRequest(constraint, seen);
    }
    if (type.isUnion() || type.isIntersection())
      return type.types.some((/** @type {any} */ t) => isRequest(t, seen));
    if ((type.getSymbol() ?? type.aliasSymbol)?.getName() === "Request") return true;
    return (
      type.isClassOrInterface() &&
      checker.getBaseTypes(type).some((/** @type {any} */ t) => isRequest(t, seen))
    );
  };
  /**
   * The strings that an expression names: the text of a literal, else each
   * string literal type of its type (`const k = "json" as const`).
   * @param {any} expression
   * @returns {string[]}
   */
  const literalsOf = (expression) => {
    if (ts.isStringLiteralLike(expression)) return [expression.text];
    const type = checker.getTypeAtLocation(expression);
    return (type.isUnion() ? type.types : [type])
      .filter((/** @type {any} */ t) => t.isStringLiteral())
      .map((/** @type {any} */ t) => t.value);
  };
  /**
   * The member names of a property access, or of an element access by a literal or a literal type.
   * @param {any} node
   * @returns {string[]}
   */
  const membersOf = (node) => {
    if (ts.isPropertyAccessExpression(node)) return [node.name.text];
    if (ts.isElementAccessExpression(node)) return literalsOf(node.argumentExpression);
    return [];
  };
  /**
   * The names of a member in a pattern: `body`, `body: alias`, `"body": alias`, or `["body"]: alias`.
   * @param {any} name
   * @returns {string[]}
   */
  const namesOf = (name) => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return [name.text];
    if (ts.isComputedPropertyName(name)) return literalsOf(name.expression);
    return [];
  };
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
      const members = membersOf(node).filter((m) => BODY_MEMBERS.includes(m));
      if (members.length > 0 && isRequest(checker.getTypeAtLocation(node.expression)))
        for (const member of members)
          reads.push(`${where(node)} ${node.expression.getText()}.${member}`);
      // `Reflect.get(request, "body")`.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText() === "Reflect" &&
        node.expression.name.text === "get" &&
        node.arguments.length >= 2 &&
        isRequest(checker.getTypeAtLocation(node.arguments[0]))
      )
        for (const member of literalsOf(node.arguments[1]).filter((m) => BODY_MEMBERS.includes(m)))
          reads.push(`${where(node)} ${node.arguments[0].getText()}.${member}`);
      // A pattern of a variable, of a parameter, or inside another pattern:
      // `const { body } = request`, `({ body }: Request) => body`, `const { request: { body } } = ctx`.
      if (ts.isObjectBindingPattern(node)) {
        const type = checker.getTypeAtLocation(node);
        const from =
          ts.isVariableDeclaration(node.parent) && node.parent.initializer
            ? `= ${node.parent.initializer.getText()}`
            : `of ${checker.typeToString(type)}`;
        for (const element of node.elements)
          for (const name of namesOf(element.propertyName ?? element.name))
            if (BODY_MEMBERS.includes(name) && isRequest(type))
              reads.push(`${where(element)} { ${name} } ${from}`);
      }
      // An assignment pattern: `({ body } = request)`.
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isObjectLiteralExpression(node.left) &&
        isRequest(checker.getTypeAtLocation(node.right))
      )
        for (const property of node.left.properties)
          for (const name of property.name === undefined ? [] : namesOf(property.name))
            if (BODY_MEMBERS.includes(name))
              reads.push(`${where(property)} { ${name} } = ${node.right.getText()}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files: count, reads };
}
