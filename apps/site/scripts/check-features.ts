import { routeLabel } from "../src/data/features.ts";
import { hrefsOf, idsOf } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** One row of FEATURES or PACKAGE_FEATURES, as the check reads it. */
interface Row {
  title: string;
  line: string;
  guide: string;
}

/** What check-features reads. check.ts passes the real tables; a test passes its own. */
export interface FeaturesInput {
  /** The folders of packages/ that hold a package.json. */
  folders: readonly string[];
  /** The built /features/ page. */
  built: string;
  /** Every file of dist, by its path relative to dist. */
  files: ReadonlySet<string>;
  /** A built file by its path relative to dist, or null when it does not exist. */
  read: (file: string) => string | null;
  features: Readonly<Record<string, Row>>;
  routes: readonly { feature: string }[];
  packages: Readonly<Record<string, Row>>;
  exempt: Readonly<Record<string, string>>;
}

/** The text of an HTML fragment: no tags, the five named entities read, the spaces joined. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The body of each section of the page with the id, after its open tag and up
 * to its end tag. An attribute of the open tag is not part of the body.
 */
function sections(html: string, id: string): string[] {
  return html
    .split(new RegExp(`<section\\b[^>]*\\sid="${id}"[^>]*>`))
    .slice(1)
    .map((rest) => rest.split("</section>")[0] ?? "");
}

/**
 * The feature table of plan 11b (spec 24) against the folders and the build.
 * 1. Each folder of packages/ is a key of PACKAGE_FEATURES or of
 *    PACKAGE_EXEMPT, never of both, and each key names a folder.
 * 2. Each guide of both tables names a page of the build. An anchor of a guide
 *    names an id of that page.
 * 3. /features/ has one section per feature, with its route count from
 *    ROUTES, and one section `pkg-<folder>` per package row. Each section
 *    links the guide of its row and shows the line of its row.
 * 4. It reads at least one folder.
 */
export function checkFeatures(input: FeaturesInput): CheckReport {
  const r: CheckReport = {
    name: "check-features",
    counts: {
      features: Object.keys(input.features).length,
      packages: Object.keys(input.packages).length,
      exempt: Object.keys(input.exempt).length,
    },
    failures: [],
    exempt: Object.entries(input.exempt).map(([folder, why]) => `packages/${folder}: ${why}`),
  };
  if (input.folders.length === 0) {
    r.failures.push("read 0 folders of packages/");
    return r;
  }
  const folders = new Set(input.folders);
  for (const folder of input.folders) {
    const row = folder in input.packages;
    const exempt = folder in input.exempt;
    if (!row && !exempt)
      r.failures.push(`packages/${folder} has no row in PACKAGE_FEATURES and no exemption`);
    if (row && exempt)
      r.failures.push(
        `packages/${folder} has a row in PACKAGE_FEATURES and an exemption; keep one`,
      );
  }
  for (const [table, keys] of [
    ["PACKAGE_FEATURES", Object.keys(input.packages)],
    ["PACKAGE_EXEMPT", Object.keys(input.exempt)],
  ] as const)
    for (const key of keys)
      if (!folders.has(key))
        r.failures.push(`${table} names ${key}, which is not a folder of packages/`);

  const guides = [
    ...Object.entries(input.features).map(([key, row]) => [`FEATURES.${key}`, row.guide] as const),
    ...Object.entries(input.packages).map(
      ([key, row]) => [`PACKAGE_FEATURES.${key}`, row.guide] as const,
    ),
  ];
  for (const [name, guide] of guides) {
    const [path = "", anchor] = guide.split("#");
    const file = `${path.slice(1)}index.html`;
    if (!path.startsWith("/") || !path.endsWith("/") || !input.files.has(file)) {
      r.failures.push(`${name}: the guide ${guide} names no page of the build`);
      continue;
    }
    if (anchor !== undefined && !idsOf(input.read(file) ?? "").has(anchor))
      r.failures.push(`${name}: the guide ${guide} names no id ${anchor} on its page`);
  }

  const rows = [
    ...Object.entries(input.features),
    ...Object.entries(input.packages).map(([folder, row]) => [`pkg-${folder}`, row] as const),
  ];
  for (const [id, row] of rows) {
    const found = sections(input.built, id);
    if (found.length !== 1)
      r.failures.push(`/features/ has ${found.length} sections with id="${id}"; it needs 1`);
    if (found.length === 0) continue;
    const body = found[0] ?? "";
    const text = textOf(body);
    if (!hrefsOf(body).includes(row.guide))
      r.failures.push(`/features/#${id} does not link its guide ${row.guide}`);
    if (!text.includes(row.line))
      r.failures.push(`/features/#${id} does not show its line "${row.line}"`);
    if (id.startsWith("pkg-")) continue;
    const n = input.routes.filter((route) => route.feature === id).length;
    const stated = /\b(\d+) routes?\b/.exec(text);
    if (stated === null) r.failures.push(`/features/#${id} states no route count; ROUTES has ${n}`);
    else if (stated[0] !== routeLabel(n))
      r.failures.push(`/features/#${id} says ${stated[0]}; ROUTES has ${n}`);
  }
  return requireCounts(r, ["features", "packages"]);
}
