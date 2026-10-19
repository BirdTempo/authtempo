import { sectionOf } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function text(cell: string): string {
  return cell
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The cells of each body row of the first table under the h2 `heading`, or null. */
function tableRows(page: string, heading: string): string[][] | null {
  const section = sectionOf(page, heading);
  const body = section === null ? null : /<table>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(section);
  if (!body) return null;
  return [...(body[1] ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...(row[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1] ?? "")),
  );
}

/**
 * Holds one table of the page to the document, both ways. `want` maps a name
 * to its fields by column; the page row of the name must hold the same text.
 */
function compareTable(
  r: CheckReport,
  page: string,
  heading: string,
  kind: string,
  columns: readonly string[],
  want: ReadonlyMap<string, readonly string[]>,
): void {
  const rows = tableRows(page, heading);
  if (rows === null) {
    r.failures.push(`the page has no section ${heading} with a table`);
    return;
  }
  const got = new Map(rows.map((cells) => [cells[0] ?? "", cells.slice(1)]));
  for (const [name, fields] of want) {
    const row = got.get(name);
    if (row === undefined) {
      r.failures.push(`${kind} ${name} has no row on the page`);
      continue;
    }
    columns.forEach((column, i) => {
      if (row[i] !== fields[i])
        r.failures.push(
          `${kind} ${name}: the page says ${column} ${row[i] ?? "(none)"}; the document says ${fields[i]}`,
        );
    });
  }
  for (const name of got.keys())
    if (!want.has(name))
      r.failures.push(`the page names ${kind} ${name}, which the document lacks`);
}

/**
 * The site's OpenAPI file (plan 11g, spec 25 item 11). `file` is the text of
 * dist/docs/reference/openapi.json, or null when the build did not write it.
 * Its bytes equal `expected`, the generator's answer for the site's input, so
 * a source change newer than the build fails here. Its operations count
 * `routeCount`, and the two tables of the reference page `page` hold the
 * document's security schemes and tags, both ways.
 */
export function checkOpenApi(
  file: string | null,
  expected: string,
  page: string,
  routeCount: number,
): CheckReport {
  const r: CheckReport = {
    name: "check-openapi",
    counts: { operations: 0, routes: routeCount, schemes: 0, tags: 0 },
    failures: [],
  };
  const required = ["operations", "routes", "schemes", "tags"];
  if (file === null) {
    r.failures.push("dist/docs/reference/openapi.json does not exist");
    return requireCounts(r, required);
  }
  if (file !== expected)
    r.failures.push(
      "the built file differs from openApiDocument of openApiReferenceOptions(); build again",
    );
  let doc: {
    paths?: Record<string, Record<string, unknown>>;
    tags?: { name: string; description?: string; "x-authtempo-default"?: string }[];
    components?: { securitySchemes?: Record<string, { type?: string }> };
  };
  try {
    doc = JSON.parse(file) as typeof doc;
  } catch {
    r.failures.push("the built file is not JSON");
    return requireCounts(r, required);
  }
  let operations = 0;
  for (const item of Object.values(doc.paths ?? {}))
    for (const method of METHODS) if (item[method] !== undefined) operations += 1;
  r.counts.operations = operations;
  if (operations !== routeCount && operations > 0)
    r.failures.push(`operations=${operations} of ${routeCount}`);

  const schemes = new Map(
    Object.entries(doc.components?.securitySchemes ?? {}).map(([name, s]) => [
      name,
      [s.type ?? "(none)"],
    ]),
  );
  r.counts.schemes = schemes.size;
  // The config key is in the tag's description, which the generator writes from FEATURE_INFO.
  const tags = new Map(
    (doc.tags ?? []).map((t) => [
      t.name,
      [
        /Config: (.+); default (?:on|off)\.$/.exec(t.description ?? "")?.[1] ?? "(none)",
        t["x-authtempo-default"] ?? "(none)",
      ],
    ]),
  );
  r.counts.tags = tags.size;
  if (operations > 0) {
    compareTable(r, page, "Security schemes", "scheme", ["type"], schemes);
    compareTable(r, page, "Tags", "tag", ["config key", "default"], tags);
  }
  return requireCounts(r, required);
}
