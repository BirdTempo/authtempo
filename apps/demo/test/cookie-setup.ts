import { afterAll } from "vitest";
import { cookieFaults } from "./cookie-rules.js";
import { SET_COOKIES } from "./helpers.js";

// A setup file of each pool file (ruling 40 of the plan 11b lane). After the
// file, it applies the cookie rule to each Set-Cookie line that call() kept.
// So a cookie of any test breaks the run, not only a cookie of everyFlow.
afterAll(() => {
  const faults = cookieFaults(SET_COOKIES);
  if (faults.length > 0) throw new Error(`demo: a cookie breaks the rule: ${faults.join("; ")}`);
});
