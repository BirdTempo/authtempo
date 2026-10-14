// The public entry of @authtempo/cli (plan 11c). It imports no Node.js
// module, so a Worker test or the docs site can read the help texts and the
// JSON shapes (and, from Task 8, runChecks). The binary is src/bin/authtempo.ts.
export { HELP } from "./help/index.js";
export { type HelpFlag, type HelpText, helpProse, pageUrl, renderHelp } from "./help/types.js";
export * from "./json.js";
