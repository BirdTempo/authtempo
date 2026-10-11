import { describe, expect, it } from "vitest";
import { csvRecords, parseCsv } from "../src/csv.js";

describe("the CSV parser", () => {
  it("reads quotes, doubled quotes, commas, line breaks, CRLF, and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, ""y""","line\nbreak"\n')).toEqual([
      ["a", "b"],
      ['x, "y"', "line\nbreak"],
    ]);
    expect(() => csvRecords("a,b\n1\n")).toThrow(/row 2 has 1 fields/);
    expect(() => parseCsv('"open')).toThrow(/inside a quoted field/);
  });
});
