import { describe, expect, it } from "vitest";
import { demoConfig } from "../src/auth.js";
import { DEMO_OFF } from "../src/facts.js";
import { createMailbox } from "../src/mailbox.js";
import worker from "../src/worker.js";
import { ORIGIN } from "./helpers.js";

/** The value at a dotted key path of `config`, or undefined. */
function at(config: unknown, path: string): unknown {
  let value: unknown = config;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

// The parts that /demo/ lists as off (final review m3 of plan 11b). A part
// that the demo turns on fails here, so the page cannot state a false fact.
// The Node test test/node/off.test.ts holds each path to a key of core.
describe("the parts that the demo turns off", () => {
  // The config reads no row at its build, so an empty store and mailbox serve.
  const config = demoConfig({
    origin: ORIGIN,
    secret: `test-only-${"x".repeat(32)}`,
    db: {} as D1Database,
    mailbox: createMailbox({} as SqlStorage),
  });

  it("leaves each config path of DEMO_OFF unset", () => {
    const paths = DEMO_OFF.flatMap((x) => (x.place.kind === "config" ? [x.place.path] : []));
    expect(paths).toEqual(["password.breachCheck", "captcha", "hooks"]);
    // The parent of a nested path is set, so the path is read in a real object.
    expect(at(config, "password")).toBeTypeOf("object");
    for (const path of paths)
      expect({ path, value: at(config, path) }).toEqual({ path, value: undefined });
  });

  it("has no scheduled handler, so no sweep runs", () => {
    expect(DEMO_OFF.filter((x) => x.place.kind === "cron").map((x) => x.name)).toEqual([
      "The sweep",
    ]);
    expect(Object.keys(worker)).toEqual(["fetch"]);
  });
});
