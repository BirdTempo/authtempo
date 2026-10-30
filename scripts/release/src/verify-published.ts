// verify-published (review M1 of plan 12j Task 13b). The owner runs it after
// the job publish, as step 10 of "At each release" in docs/release/RUNBOOK.md.
// For each released name of releasedNames, it reads the version document of
// the group version from the public registry. The document must hold
// dist.attestations with the SLSA provenance predicate. `npm audit signatures`
// cannot take this place. It counts the attestations of every installed
// package, such as zod and each peer. So its count never equals the released
// count. A version that the owner published by hand (the token fallback of the
// runbook) has no attestation. Only a version that release/fallback-published.json
// lists, with its date and reason, may lack one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_REGISTRY } from "./lib/release-facts.ts";
import { releasedNames } from "./lib/released.ts";
import { type Report, reportLines, requireCounts, unreadReport } from "./lib/report.ts";
import { readWorkspace } from "./lib/workspace.ts";

/**
 * The predicate type of npm provenance (registry.npmjs.org, read 2026-10-30
 * 03:13 UTC). The version documents of zod 4.6.6 and @sveltejs/kit 3.0.1 hold
 * it in dist.attestations.provenance.predicateType. The document of postgres
 * 3.4.9 has no provenance, and it has no dist.attestations.
 */
export const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";

/** The file of the versions that the owner published by hand, from the repository root. */
export const FALLBACK_FILE = "release/fallback-published.json";

/** The time that one registry read may take before the check counts it as no answer. */
const TIMEOUT_MS = 20_000;

const VERSION = /^\d+\.\d+\.\d+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COUNTS = ["packages", "attested", "fallback"] as const;

/** The fetch seam: the entry passes globalThis.fetch, and a test passes a fake. */
export type RegistryGet = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** One entry of release/fallback-published.json. Only the owner writes one. */
export interface FallbackEntry {
  /** The group version that the owner published by hand. */
  version: string;
  /** The day of that publish, YYYY-MM-DD. */
  date: string;
  /** Why the workflow could not publish it. */
  reason: string;
}

export interface VerifyInput {
  /** releasedNames: fixed[0] of .changeset/config.json. */
  names: readonly string[];
  /** The group version. */
  version: string;
  fallback: readonly FallbackEntry[];
  get: RegistryGet;
  registry?: string;
  timeoutMs?: number;
}

/** The version document of a name. A scoped name has its slash as %2f, as npm writes it. */
export const versionUrl = (registry: string, name: string, version: string): string =>
  `${registry}${name.replace("/", "%2f")}/${version}`;

/** True for a real calendar day in the form YYYY-MM-DD. */
function isDay(text: unknown): boolean {
  if (typeof text !== "string" || !DAY.test(text)) return false;
  const t = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === text;
}

/** The faults of the fallback file: each entry has a version, a real day, and a reason, once. */
function fallbackFaults(entries: readonly FallbackEntry[]): string[] {
  const faults: string[] = [];
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    const at = `${FALLBACK_FILE} entry ${i + 1}`;
    if (typeof e.version !== "string" || !VERSION.test(e.version))
      faults.push(`${at}: the version ${String(e.version)} is not <major>.<minor>.<patch>`);
    else if (seen.has(e.version)) faults.push(`${at}: the version ${e.version} is listed twice`);
    else seen.add(e.version);
    if (!isDay(e.date)) faults.push(`${at}: the date ${String(e.date)} is not a real YYYY-MM-DD`);
    if (typeof e.reason !== "string" || e.reason.trim() === "")
      faults.push(`${at}: it has no reason`);
  });
  return faults;
}

/** One registry read through the seam, with a time limit. It throws a reason when no answer comes. */
async function readDocument(
  input: VerifyInput,
  url: string,
): Promise<{ status: number; body: unknown }> {
  const timeoutMs = input.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer in ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await input.get(url, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        return {
          status: response.status,
          body: response.status === 200 ? await response.json() : null,
        };
      })(),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Each released name at the group version has a provenance attestation on the
 * registry. A missing attestation fails, unless the fallback file lists the
 * version. No answer from the registry is a failure, never a pass.
 */
export async function verifyPublished(input: VerifyInput): Promise<Report> {
  const failures: string[] = [];
  const notes: string[] = [];
  const counts = { packages: input.names.length, attested: 0, fallback: 0 };
  const registry = input.registry ?? PUBLIC_REGISTRY;
  if (registry !== PUBLIC_REGISTRY)
    notes.push(`the registry is ${registry}, not ${PUBLIC_REGISTRY}: this run did not read npm`);

  const { version } = input;
  if (!VERSION.test(version))
    failures.push(`the version ${version} is not <major>.<minor>.<patch>`);
  else if (version === "0.0.0")
    failures.push("the group version is 0.0.0, so no release exists to verify");
  failures.push(...fallbackFaults(input.fallback));
  if (failures.length > 0)
    return requireCounts({ name: "verify-published", counts, failures, notes }, ["packages"]);

  const byHand = input.fallback.find((e) => e.version === version);
  if (byHand !== undefined)
    notes.push(
      `${FALLBACK_FILE} lists ${version} (${byHand.date}: ${byHand.reason}), so a missing attestation passes`,
    );

  for (const name of input.names) {
    const at = `${name}@${version}`;
    let answer: { status: number; body: unknown };
    try {
      answer = await readDocument(input, versionUrl(registry, name, version));
    } catch (error) {
      failures.push(
        `${at}: no answer from the registry is not a pass: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (answer.status === 404) {
      failures.push(`${at}: the registry has no such version`);
      continue;
    }
    if (answer.status !== 200) {
      failures.push(`${at}: the registry answered status ${answer.status}`);
      continue;
    }
    const doc = (answer.body ?? {}) as {
      name?: unknown;
      version?: unknown;
      dist?: { attestations?: { provenance?: { predicateType?: unknown } } };
    };
    if (doc.name !== name || doc.version !== version) {
      failures.push(
        `${at}: the registry answered the document of ${String(doc.name)}@${String(doc.version)}`,
      );
      continue;
    }
    const predicate = doc.dist?.attestations?.provenance?.predicateType;
    if (predicate === PROVENANCE_PREDICATE) counts.attested += 1;
    else if (byHand !== undefined) counts.fallback += 1;
    else
      failures.push(
        predicate === undefined
          ? `${at}: the registry holds no provenance attestation`
          : `${at}: the provenance predicate is ${String(predicate)}, not ${PROVENANCE_PREDICATE}`,
      );
  }
  return requireCounts({ name: "verify-published", counts, failures, notes }, ["packages"]);
}

/** The group version: every released package has one version (check-packages holds it). */
function groupVersion(root: string, names: readonly string[]): string {
  const released = new Set(names);
  const versions = [
    ...new Set(
      readWorkspace(root)
        .filter((p) => released.has(p.name))
        .map((p) => p.manifest.version),
    ),
  ];
  const [only] = versions;
  if (versions.length !== 1 || only === undefined)
    throw new Error(
      `the released packages hold ${versions.length} versions: ${versions.join(", ")}`,
    );
  return only;
}

/**
 * The input of the tree at `root`: the names from releasedNames, the version
 * from the argument or else the group version, and the fallback file. A file
 * that is missing or not a JSON array throws.
 */
export function readVerifyInput(
  root: string,
  version: string | undefined,
): { names: string[]; version: string; fallback: FallbackEntry[] } {
  const names = releasedNames(root);
  const fallback = JSON.parse(readFileSync(join(root, FALLBACK_FILE), "utf8")) as unknown;
  if (!Array.isArray(fallback)) throw new Error(`${FALLBACK_FILE} is not a JSON array`);
  return {
    names,
    version: version ?? groupVersion(root, names),
    fallback: fallback as FallbackEntry[],
  };
}

/** Runs the check on the tree at `root`. Each line goes to the output, and the code is 1 on a failure. */
export async function entry(
  root: string,
  version: string | undefined,
  get: RegistryGet,
): Promise<{ lines: string[]; code: number }> {
  let report: Report;
  try {
    report = await verifyPublished({ ...readVerifyInput(root, version), get });
  } catch (error) {
    report = unreadReport(
      "verify-published",
      COUNTS,
      error instanceof Error ? error.message : String(error),
    );
  }
  return { lines: reportLines(report), code: report.failures.length > 0 ? 1 : 0 };
}

if (import.meta.main) {
  const { lines, code } = await entry(
    fileURLToPath(new URL("../../../", import.meta.url)),
    process.argv[2],
    globalThis.fetch,
  );
  for (const line of lines) console.log(line);
  process.exit(code);
}
