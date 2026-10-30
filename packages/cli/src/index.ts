// The public entry of @authtempo/cli (plan 11c). It imports no Node.js
// module, so a Worker test or the docs site can read the help texts and the
// JSON shapes (and, from Task 8, runChecks). The binary is src/bin/authtempo.ts.

// The docs site holds the version of its Better Auth cautions to this export.
export { BETTER_AUTH_FIXED } from "./better-auth-version.js";
// The docs site holds the anchors of its changelog page to this link (plan 12j Task 13).
export { changelogLink } from "./changelog-link.js";
export {
  ALL_CHECK_CODES,
  CHECK_CODES,
  CHECK_IDS,
  type CheckId,
  type CheckInput,
  type CheckReport,
  type CheckResult,
  type CheckStatus,
  runChecks,
} from "./checks.js";
export { EDITORS, type EditorId, type EditorSpec, REMOTE_MCP_URL } from "./editors.js";
export { HELP } from "./help/index.js";
export { type HelpFlag, type HelpText, helpProse, pageUrl, renderHelp } from "./help/types.js";
export * from "./json.js";
export { type Fetcher, HostError } from "./net.js";
// The docs site holds the CLI quotes of its runbooks to these (ruling 62 m7 of plan 12f).
export {
  bannedText,
  familyEndWarning,
  REASON_RULE,
  reasonProblem,
  secretHashLine,
  USER_HEADER,
  userRow,
  writtenLine,
} from "./operator-tools.js";
export { compareShape, PLAIN_NAME, type ShapeFinding } from "./schema-shape.js";
