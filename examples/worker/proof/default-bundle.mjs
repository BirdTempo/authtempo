// The deployed bundle holds no part of the conformance mode (plan 12e Task 17, ruling 53).
//
// wrangler deploy --dry-run bundles wrangler.jsonc and wrangler.conformance.jsonc.
// The default bundle must hold none of the mode's marks. The conformance
// bundle must hold each one, because a scan that cannot see a mark proves nothing.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The seed code, the test address, the secret log line, and the suite origin.
const MARKS = [
  "seedConformance",
  "conformance-user@example.test",
  "client_secret=",
  "localhost.emobix.co.uk",
];

function bundle(config) {
  const out = mkdtempSync(join(tmpdir(), "authtempo-bundle-"));
  try {
    const run = spawnSync(
      "pnpm",
      ["exec", "wrangler", "deploy", "--dry-run", "--config", config, "--outdir", out],
      {
        encoding: "utf8",
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        // The four keys of ruling 40 of plan 11e: no banner, no update check, no metrics.
        env: {
          ...process.env,
          CI: "1",
          WRANGLER_SEND_METRICS: "false",
          NO_COLOR: "1",
          WRANGLER_HIDE_BANNER: "true",
        },
      },
    );
    if (run.status !== 0) {
      console.error(`${run.stdout}\n${run.stderr}`);
      throw new Error(`wrangler exited ${run.status} for ${config}`);
    }
    const files = readdirSync(out).filter((n) => /\.m?js$/.test(n));
    if (files.length === 0) throw new Error(`no bundle file for ${config}`);
    return {
      files: files.length,
      text: files.map((f) => readFileSync(join(out, f), "utf8")).join("\n"),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const failures = [];
const main = bundle("wrangler.jsonc");
for (const m of MARKS) if (main.text.includes(m)) failures.push(`the default bundle holds ${m}`);
const mode = bundle("wrangler.conformance.jsonc");
for (const m of MARKS)
  if (!mode.text.includes(m)) failures.push(`the conformance bundle lacks ${m}`);
if (failures.length > 0) {
  console.error(`default-bundle: FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(
  `default-bundle: PASS, ${MARKS.length} marks absent from ${main.files} default bundle file(s) and present in ${mode.files} conformance bundle file(s)`,
);
