import { describe, expect, it } from "vitest";
import { checkRoutes } from "../scripts/check-routes.ts";
import { routeAnchor } from "../scripts/lib/anchors.ts";

const routes = [
  { method: "GET", path: "/session" },
  { method: "GET", path: "/.well-known/openid-configuration" },
];
const page = `<h3 id="get-session"><code>GET /session</code></h3>
<h3 id="get-well-known-openid-configuration"><code>GET /.well-known/openid-configuration</code></h3>`;

describe("checkRoutes", () => {
  it("builds one anchor per route", () => {
    expect(routeAnchor("POST", "/social/:provider/start")).toBe("post-social-provider-start");
    expect(routeAnchor("GET", "/.well-known/openid-configuration")).toBe(
      "get-well-known-openid-configuration",
    );
  });

  it("passes a page with one heading per route", () => {
    const r = checkRoutes(page, routes);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ routes: 2, anchors: 2 });
  });

  it("refuses a route with no anchor, an anchor with no route, and a heading that names another route", () => {
    const r = checkRoutes(
      `${page.replace("<code>GET /session</code>", "<code>POST /session</code>")}\n<h3 id="get-gone"><code>GET /gone</code></h3>`,
      [...routes, { method: "POST", path: "/sign-out" }],
    );
    expect(r.failures).toEqual([
      "#get-session names POST /session; the route is GET /session",
      "route POST /sign-out has no anchor #post-sign-out",
      "anchor #get-gone names no route",
    ]);
  });

  it("fails when it reads no route", () => {
    expect(checkRoutes("", []).failures).toEqual(["read 0 routes", "read 0 anchors"]);
  });
});
