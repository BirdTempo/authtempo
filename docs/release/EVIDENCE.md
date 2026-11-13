# Release evidence

One dated line for each release. Step 15 of `RUNBOOK.md` appends it, on a new branch and by a pull request.

This file is a record, and it is append-only. Do not edit an old line. A fault in a line gets a dated correction in a new line.

Each line names the version, the tagged commit, the `verify-published` line, and the `release-dry-run` line of the job `check` of `release.yml`.
