import { errorAnchor } from "./lib/anchors.ts";
import { h3Headings } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/**
 * Every code of ERRORS and of OAUTH_ERRORS has an h3 anchor on the error page
 * whose heading states its status, and every h3 anchor names a code. Spec 18,
 * the error-page rule.
 */
export function checkErrors(
  html: string,
  core: Readonly<Record<string, number>>,
  oauth: Readonly<Record<string, number>>,
): CheckReport {
  const headings = h3Headings(html);
  const r: CheckReport = {
    name: "check-errors",
    counts: {
      codes: Object.keys(core).length + Object.keys(oauth).length,
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
    if (status !== String(e.status))
      r.failures.push(`#${id} says status ${status}; ${e.table} says ${e.status}`);
  }
  for (const h of headings)
    if (!expected.has(h.id)) r.failures.push(`anchor #${h.id} names no code`);
  return requireCounts(r, ["codes", "anchors"]);
}
