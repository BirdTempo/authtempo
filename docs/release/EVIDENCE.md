# Release evidence

One dated line for each release. Step 15 of `RUNBOOK.md` appends it, on a new branch and by a pull request.

This file is a record, and it is append-only. Do not edit an old line. A fault in a line gets a dated correction in a new line.

Each line names the version, the tagged commit, the `verify-published` line, and the `release-dry-run` line of the job `check` of `release.yml`.

- 2026-11-16: 0.1.0, tagged commit `5772180a`. `verify-published: PASS packages=27 attested=0 fallback=27 failures=0`. `release-dry-run: PASS packages=27 of 27 version=0.1.0 tarballs=27 files=1874 smoke=2 failures=0` (step `Dry run the tarballs`, job `check`, run 43833267598). The owner published the 27 packages by hand with a token and no provenance, because npm offered no trusted publisher for a package with no version. `release/fallback-published.json` lists them (pull request 3). The first publish of core is 2026-11-16T09:16:10Z. The Apple real-token checks did not run before this release. The routes page of the site says which real-token checks ran and which did not. The job `publish` of run 43833267598 stays unapproved.
