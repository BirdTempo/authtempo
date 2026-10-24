import { describe, expect, it } from "vitest";
import {
  IDENTITY_HOOK_POINTS,
  OPERATOR_HOOK_POINTS,
  ORGANIZATION_HOOK_POINTS,
  SCIM_HOOK_POINTS,
  SESSION_HOOK_POINTS,
  SSO_HOOK_POINTS,
  USER_HOOK_POINTS,
} from "../src/engine/hooks.js";
import { EVENTS, HOOK_EVENTS } from "../src/observe/events.js";

// The seven hook point constants of src/engine/hooks.ts (plan 12h Task 6;
// plan 12d adds sso and scim). A new constant joins this list and the hook
// name union.
const POINTS: readonly [string, Readonly<Record<string, true>>][] = [
  ["organization", ORGANIZATION_HOOK_POINTS],
  ["session", SESSION_HOOK_POINTS],
  ["user", USER_HOOK_POINTS],
  ["identity", IDENTITY_HOOK_POINTS],
  ["operator", OPERATOR_HOOK_POINTS],
  ["sso", SSO_HOOK_POINTS],
  ["scim", SCIM_HOOK_POINTS],
];
const HOOK_NAMES = POINTS.flatMap(([group, points]) =>
  Object.keys(points).map((p) => `${group}.${p}`),
);

describe("the hook map", () => {
  it("maps every hook point to an event or an exempt row with a reason", () => {
    const missing = HOOK_NAMES.filter((n) => !Object.hasOwn(HOOK_EVENTS, n));
    expect(missing).toEqual([]);
    for (const name of HOOK_NAMES) {
      const row = (HOOK_EVENTS as Record<string, unknown>)[name];
      if (typeof row === "string") expect(Object.hasOwn(EVENTS, row), name).toBe(true);
      else {
        const reason = (row as { exempt: unknown }).exempt;
        expect(typeof reason, name).toBe("string");
        // A sentence: a capital first and a period last.
        expect(reason as string, name).toMatch(/^[A-Z].*\.$/);
      }
    }
    // 44 of plan 12h, and sso.beforeSignIn and scim.afterChange of plan 12d.
    expect(HOOK_NAMES).toHaveLength(46);
  });

  it("has no row for a hook point that does not exist", () => {
    const extra = Object.keys(HOOK_EVENTS).filter((n) => !HOOK_NAMES.includes(n));
    expect(extra).toEqual([]);
  });

  it("maps each organization point by its kind, and the operator points to their events", () => {
    for (const p of Object.keys(ORGANIZATION_HOOK_POINTS)) {
      const row = (HOOK_EVENTS as Record<string, unknown>)[`organization.${p}`];
      if (p.startsWith("after")) expect(row, p).toBe("organization.change");
      else
        expect(row, p).toEqual({
          exempt: "A refusal answers hook_refused, and the request event carries it.",
        });
    }
    expect(HOOK_EVENTS["session.afterCreate"]).toBe("sign_in");
    expect(HOOK_EVENTS["operator.afterAction"]).toBe("operator.action");
    expect(HOOK_EVENTS["operator.beforeAction"]).toBe("operator.refused");
    expect(HOOK_EVENTS["sso.beforeSignIn"]).toEqual({
      exempt: "A refusal answers hook_refused, and the request event carries it.",
    });
    expect(HOOK_EVENTS["scim.afterChange"]).toBe("scim.change");
  });
});
