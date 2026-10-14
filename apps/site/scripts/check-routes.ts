import { routeAnchor } from "./lib/anchors.ts";
import { h3Headings } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** Every route of ROUTES has an h3 anchor whose heading names it, and every h3 anchor names a route. */
export function checkRoutes(
  html: string,
  routes: readonly { method: string; path: string }[],
): CheckReport {
  const headings = h3Headings(html);
  const r: CheckReport = {
    name: "check-routes",
    counts: { routes: routes.length, anchors: headings.length },
    failures: [],
  };
  const seen = new Map(headings.map((h) => [h.id, h.text]));
  const expected = new Set<string>();
  for (const route of routes) {
    const id = routeAnchor(route.method, route.path);
    expected.add(id);
    const text = seen.get(id);
    const name = `${route.method} ${route.path}`;
    if (text === undefined) r.failures.push(`route ${name} has no anchor #${id}`);
    else if (text !== name) r.failures.push(`#${id} names ${text}; the route is ${name}`);
  }
  for (const h of headings)
    if (!expected.has(h.id)) r.failures.push(`anchor #${h.id} names no route`);
  return requireCounts(r, ["routes", "anchors"]);
}
