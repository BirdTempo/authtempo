// The secret scan of CI (job "leaks" of .github/workflows/ci.yml). It scans
// the whole git history with the rules of .gitleaks.toml and exits 1 on a
// finding. Run it from the repository root: node scripts/secret-scan.mjs.
//
// The scanner is a supplier, so this file is the seam. The rules and the
// allowlist belong to the repository (.gitleaks.toml). A replacement scanner
// changes only the pin and the run call below. We do not use the gitleaks
// GitHub action: it needs a license key for an organization, and it runs with
// a token. A pinned binary with a checked hash needs neither.
//
// The version and the hashes are from the release v8.30.1 (2026-03-21). The
// hashes are from gitleaks_8.30.1_checksums.txt, and each one equals the hash
// of the archive that we computed ourselves on 2026-11-24. To move to a new
// version: change VERSION and both hashes in one commit, and run the scan on
// the full history. A new rule can find an old value.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "8.30.1";
const ARCHIVES = {
  "linux-x64": {
    file: `gitleaks_${VERSION}_linux_x64.tar.gz`,
    sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  },
  "darwin-arm64": {
    file: `gitleaks_${VERSION}_darwin_arm64.tar.gz`,
    sha256: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  },
};

const archive = ARCHIVES[`${process.platform}-${process.arch}`];
if (archive === undefined) {
  console.error(`secret-scan: no pinned archive for ${process.platform}-${process.arch}`);
  process.exit(1);
}

const url = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${archive.file}`;
const response = await fetch(url);
if (!response.ok) {
  console.error(`secret-scan: ${url} answered ${response.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
// Without this check, a changed archive runs on the runner.
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== archive.sha256) {
  console.error(`secret-scan: ${archive.file} has the hash ${sha256}, not ${archive.sha256}`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "gitleaks-"));
writeFileSync(join(dir, archive.file), bytes);
const unpack = spawnSync("tar", ["-xzf", archive.file, "gitleaks"], { cwd: dir, stdio: "inherit" });
if (unpack.status !== 0) process.exit(1);

// --redact keeps the value of a finding out of the log of the job.
const scan = spawnSync(
  join(dir, "gitleaks"),
  ["git", "--redact", "--no-banner", "--exit-code", "1", "--config", ".gitleaks.toml", "."],
  { stdio: "inherit" },
);
process.exit(scan.status ?? 1);
