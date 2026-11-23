import { ROUTES, type RouteKey } from "../src/http/route-list.js";

/**
 * The routes that ROUTES lists before a task mounts them (plan 13a). Task 0 adds the keys and
 * the contracts of the enterprise setup, and Tasks 2 to 11 mount the handlers. A test that sends
 * a request to each route, or ties each entry to a mount, reads MOUNTED_ROUTES. The test
 * "lists only routes that no module mounts" in test/route-list.test.ts holds each key here to
 * no mount: a task that mounts a route removes its key here, or that test fails.
 */
export const UNMOUNTED_ROUTES: ReadonlySet<string> = new Set<RouteKey>([
  // Plan 13b Task 0 adds the key and the contract; Task 6 mounts the handler.
  "GET /organizations/audit",
]);

/** ROUTES without the keys above, in the order of ROUTES. */
export const MOUNTED_ROUTES = ROUTES.filter((r) => !UNMOUNTED_ROUTES.has(`${r.method} ${r.path}`));
