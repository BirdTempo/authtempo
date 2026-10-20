// The facts of the release that more than one file reads (plan 12j). Each
// consumer imports the value from here, so a change happens in one place.

/** The release workflow under .github/workflows/. Read by check-workflows and the runbook test. */
export const WORKFLOW_FILE = "release.yml";

/** The workflow of each pull request and each push to main. Read by check-workflows and the runbook test. */
export const CI_FILE = "ci.yml";

/** The GitHub environment of the publish job, with the owner as the required reviewer. Read by check-workflows and the runbook test. */
export const ENVIRONMENT = "release";

/** The prefix of the release tag `v<version>`. Read by check-tag, check-workflows, and the runbook test. */
export const TAG_PREFIX = "v";

/** The lowest npm that publishes by trusted publishing. Read by publish, check-workflows, and the runbook test. */
export const NPM_FLOOR = "11.5.1";

/**
 * The lowest Node that the workflows run. Read by check-workflows and the
 * runbook test. npm trusted publishing needs 22.14.0. The release scripts and
 * the pack proofs are .ts files, and Node strips types by default from 22.18.0
 * (ruling 14 of plan 12j), so the floor is 22.18.0.
 */
export const NODE_FLOOR = "22.18.0";
