// The facts of the release that more than one file reads (plan 12j). Each
// consumer imports the value from here, so a change happens in one place.

/** The release workflow under .github/workflows/. Read by check-workflows and the runbook test. */
export const WORKFLOW_FILE = "release.yml";

/** The workflow of each pull request and each push to main. Read by check-workflows and the runbook test. */
export const CI_FILE = "ci.yml";

/** The GitHub environment of the publish job, with the owner as the required reviewer. Read by check-workflows and the runbook test. */
export const ENVIRONMENT = "release";

/**
 * The version of the first release (spec 33 item 1.2). A patch at 0.0.0
 * gives 0.0.1, so three checks refuse a release at 0.0.x (rulings 28, 30,
 * and 31 of plan 12j). The version pull request fails check-packages. The
 * tag v0.0.x fails check-tag. A released package at 0.0.x in the release copy
 * fails check-pack. The site check check-policy-pages holds the versioning
 * page to this value.
 */
export const FIRST_RELEASE = "0.1.0";

/** The prefix of the release tag `v<version>`. Read by check-tag, check-workflows, and the runbook test. */
export const TAG_PREFIX = "v";

/**
 * The scope of each released name. Read by dry-run and publish. npm and pnpm
 * send a scoped name to the scope registry of an npmrc, not to --registry. The
 * review of Task 6 (M1) read that `npm login --scope=@authtempo` writes such a line.
 */
export const SCOPE = "@authtempo";

/** The public registry, where the publish job publishes. Read by publish and verify-published. */
export const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

/** The lowest npm that publishes by trusted publishing. Read by publish, check-workflows, and the runbook test. */
export const NPM_FLOOR = "11.5.1";

/**
 * The lowest Node that the workflows run. Read by check-workflows and the
 * runbook test. npm trusted publishing needs 22.14.0. The release scripts and
 * the pack proofs are .ts files. Node strips types by default from 22.18.0
 * (ruling 14 of plan 12j), so the floor is 22.18.0.
 */
export const NODE_FLOOR = "22.18.0";
