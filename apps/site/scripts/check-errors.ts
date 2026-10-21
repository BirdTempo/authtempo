import { errorAnchor } from "./lib/anchors.ts";
import { h3Headings } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/**
 * Every code of ERRORS and of OAUTH_ERRORS has an h3 anchor on the error page
 * whose heading states its status, and every h3 anchor names a code. Spec 18,
 * the error-page rule.
 *
 * The third table is STORAGE_ERROR_CODES (plan 12g, ruling 1 of its lane): the
 * codes of `StorageError`. A storage code has no HTTP status, so its heading
 * states none. Its anchor is the code, as for ERRORS. A code in both tables
 * fails, because one page cannot hold one id twice.
 */
export function checkErrors(
  html: string,
  core: Readonly<Record<string, number>>,
  oauth: Readonly<Record<string, number>>,
  storage: readonly string[],
): CheckReport {
  const headings = h3Headings(html);
  const r: CheckReport = {
    name: "check-errors",
    counts: {
      codes: Object.keys(core).length + Object.keys(oauth).length + storage.length,
      anchors: headings.length,
    },
    failures: [],
  };
  const expected = new Map<string, { code: string; status: number; table: string }>();
  for (const [code, status] of Object.entries(core))
    expected.set(errorAnchor(code, "core"), { code, status, table: "ERRORS" });
  for (const [code, status] of Object.entries(oauth))
    expected.set(errorAnchor(code, "oauth"), { code, status, table: "OAUTH_ERRORS" });
  const seen = new Map(headings.map((h) => [h.id, h.text]));
  for (const [id, e] of expected) {
    const text = seen.get(id);
    if (text === undefined) {
      r.failures.push(
        `${e.table === "ERRORS" ? "core" : "oauth"} code ${e.code} has no anchor #${id}`,
      );
      continue;
    }
    const status = /\s(\d{3})$/.exec(text)?.[1];
    if (status === undefined)
      r.failures.push(`#${id} states no status; ${e.table} says ${e.status}`);
    else if (status !== String(e.status))
      r.failures.push(`#${id} says status ${status}; ${e.table} says ${e.status}`);
  }
  const storageIds = new Set<string>();
  for (const code of storage) {
    const id = errorAnchor(code, "core");
    if (expected.has(id)) {
      r.failures.push(`storage code ${code} is also in ERRORS; the anchor #${id} cannot be both`);
      continue;
    }
    storageIds.add(id);
    const text = seen.get(id);
    if (text === undefined) r.failures.push(`storage code ${code} has no anchor #${id}`);
    else if (text.trim() !== code)
      r.failures.push(`#${id} must state the code ${code} only; a storage code has no status`);
  }
  for (const h of headings)
    if (!expected.has(h.id) && !storageIds.has(h.id))
      r.failures.push(`anchor #${h.id} names no code`);
  return requireCounts(r, ["codes", "anchors"]);
}
