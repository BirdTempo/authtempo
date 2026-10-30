// The raw request body reads of a package (ruling 46 Minor 1 of the 12j
// lane). Each body read must go through the capped reader of core, so a
// read of `json`, `text`, `formData`, `arrayBuffer`, `blob`, `bytes`, or
// `body` on a Request, a clone of one too, fails the source scan of core
// and of compat-better-auth outside the reader files that each one allows.
// The scan uses the TypeScript compiler API and its type checker, not a
// regular expression (lessons of 2026-10-09): only a receiver whose type is
// Request counts, so a read of a Response passes.

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
    type.isUnion()
      ? type.types.some(isRequest)
      : (type.getSymbol() ?? type.aliasSymbol)?.getName() === "Request";
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
      if (ts.isPropertyAccessExpression(node) && BODY_MEMBERS.includes(node.name.text)) {
        const call = ts.isCallExpression(node.parent) && node.parent.expression === node;
        const member = node.name.text;
        if ((member === "body" || call) && isRequest(checker.getTypeAtLocation(node.expression)))
          reads.push(`${where(node)} ${node.expression.getText()}.${member}`);
      }
      // `const { body } = request`, and each other member in a pattern.
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isObjectBindingPattern(node.name)
      )
        for (const element of node.name.elements) {
          const name = (element.propertyName ?? element.name).getText();
          if (BODY_MEMBERS.includes(name) && isRequest(checker.getTypeAtLocation(node.initializer)))
            reads.push(`${where(element)} { ${name} } = ${node.initializer.getText()}`);
        }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files: count, reads };
}
