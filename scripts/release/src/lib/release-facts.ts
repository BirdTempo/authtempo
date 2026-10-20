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

/** The lowest Node that the release workflow runs, for npm trusted publishing. Read by check-workflows and the runbook test. */
export const NODE_FLOOR = "22.14.0";
