# The workspace of fixtures/turbo-logs/pass.txt

A real run on the branch of plan 12j Task 14 wrote pass.txt:
`node scripts/test-servers.mjs run -- pnpm turbo run test typecheck typecheck:configs --force`,
filtered to `//` and the five packages here. This tree names the same five
packages, so release-check reads the log against the workspace of the run.
