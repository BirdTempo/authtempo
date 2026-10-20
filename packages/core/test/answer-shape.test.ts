import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ENTERED, NO_KEYS, shapeOf, shapePaths, shapeVerdict } from "./setup/answer-shape.js";

// Two closed branches that differ only in the value of `state`, and one optional key.
const byEnum = z.union([
  z.strictObject({
    state: z.enum(["pending", "held"]),
    user: z.string(),
    note: z.string().optional(),
  }),
  z.strictObject({ state: z.enum(["done", "gone"]), user: z.string() }),
]);
const byPattern = z.union([
  z.strictObject({ id: z.string().regex(/^tk_/), note: z.string().optional() }),
  z.strictObject({ id: z.string().regex(/^to_/) }),
]);
const byFormat = z.union([
  z.strictObject({ at: z.iso.datetime(), note: z.string().optional() }),
  z.strictObject({ at: z.string() }),
]);

describe("the shape walk of the answer check (plan 11g)", () => {
  it("reads a body of a union under the branch of its enum value", () => {
    expect(shapeOf(byEnum, { state: "done", user: "u" })).toEqual({
      absent: [],
      nulls: [],
      twoBranches: [],
    });
    expect(shapeOf(byEnum, { state: "held", user: "u" })).toEqual({
      absent: ["note"],
      nulls: [],
      twoBranches: [],
    });
  });

  it("reads a body of a union under the branch of its pattern", () => {
    expect(shapeOf(byPattern, { id: "to_1" })).toEqual({ absent: [], nulls: [], twoBranches: [] });
    expect(shapeOf(byPattern, { id: "tk_1" })).toEqual({
      absent: ["note"],
      nulls: [],
      twoBranches: [],
    });
  });

  it("reports a body that fits two branches", () => {
    expect(shapeOf(byFormat, { at: "2026-10-19T00:00:00.000Z" }).twoBranches).toEqual([
      "the answer",
    ]);
    expect(
      shapeOf(z.strictObject({ last: byFormat }), { last: { at: "2026-10-19T00:00:00.000Z" } })
        .twoBranches,
    ).toEqual(["last"]);
  });

  it("fails the record of a body that fits two branches", () => {
    // The recorder writes this verdict, and the check prints it beside the route key.
    expect(shapeVerdict(byFormat, { at: "2026-10-19T00:00:00.000Z" })).toEqual({
      verdict: "the body fits two branches of a union at the answer",
      absent: ["note"],
      nulls: [],
    });
    expect(shapeVerdict(byEnum, { state: "held", user: "u" })).toEqual({
      verdict: "ok",
      absent: ["note"],
      nulls: [],
    });
  });

  it("blocks each node that can hold keys and that the walk does not enter", () => {
    const shared = z.strictObject({ at: z.string().optional() }).meta({ id: "AnswerShapeShared" });
    expect(shapePaths(z.strictObject({ one: shared, two: shared })).blocked).toEqual([
      "the walk cannot enter $defs at the answer",
      "the walk cannot enter $ref at one",
      "the walk cannot enter $ref at two",
    ]);
    // Zod writes an intersection of two objects as one object, so a tuple stands in for allOf here.
    const pair = z.tuple([z.strictObject({ a: z.string().optional() })]);
    expect(shapePaths(pair).blocked).toEqual(["the walk cannot enter prefixItems at the answer"]);
    const tagged = z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("a"), x: z.string().optional() }),
      z.strictObject({ kind: z.literal("b") }),
    ]);
    expect(shapePaths(tagged).blocked).toEqual(["the walk cannot enter oneOf at the answer"]);
  });

  it("enters a record of lists of scalars and blocks a record of lists of objects", () => {
    // A statement set (plan 12k): free resource keys, each a list of action names.
    const statements = z.strictObject({ permissions: z.record(z.string(), z.array(z.string())) });
    expect(shapePaths(statements)).toEqual({ paths: [], blocked: [] });
    // A free value (`metadata`) and a scalar value hold no key either.
    expect(shapePaths(z.record(z.string(), z.unknown()))).toEqual({ paths: [], blocked: [] });
    expect(shapePaths(z.record(z.string(), z.number()))).toEqual({ paths: [], blocked: [] });
    const lists = z.record(z.string(), z.array(z.strictObject({ at: z.string().optional() })));
    expect(shapePaths(lists).blocked).toEqual([
      "the walk cannot enter a record of shaped values at the answer",
    ]);
  });

  it("blocks a record of lists of a oneOf or a tuple, and a record of a oneOf or a tuple", () => {
    // The walk does not read the keywords of a record's value, so the record rule blocks them (review 12k Task 3, M3).
    const tagged = z.discriminatedUnion("k", [
      z.strictObject({ k: z.literal("x"), a: z.string().optional() }),
      z.strictObject({ k: z.literal("y") }),
    ]);
    const tuple = z.tuple([z.strictObject({ a: z.string().optional() })]);
    // A tuple with a rest of strings has scalar `items` beside `prefixItems`.
    const rest = z.tuple([z.strictObject({ a: z.string().optional() })], z.string());
    for (const value of [z.array(tagged), z.array(tuple), tagged, rest])
      expect(shapePaths(z.record(z.string(), value))).toEqual({
        paths: [],
        blocked: ["the walk cannot enter a record of shaped values at the answer"],
      });
  });

  it("enters six keywords and reads twenty-one as keywords that hold no key", () => {
    // A keyword that holds keys, such as $ref or $defs, must never join NO_KEYS: it hides them.
    expect([...ENTERED]).toEqual([
      "type",
      "properties",
      "required",
      "items",
      "anyOf",
      "additionalProperties",
    ]);
    expect([...NO_KEYS]).toEqual([
      "$schema",
      "const",
      "enum",
      "format",
      "pattern",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "uniqueItems",
      "propertyNames",
      "contentEncoding",
      "description",
      "title",
      "default",
      "examples",
    ]);
  });
});
