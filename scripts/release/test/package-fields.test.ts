import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

// The SPDX "MIT" license text (license list 3.29.0, read 2026-10-20), with the
// copyright line of plan 12j. The test compares words, not line breaks.
const MIT_TEXT = `MIT License

Copyright (c) 2026 BirdTempo

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

const words = (text: string) => text.trim().split(/\s+/).join(" ");

describe("package fields", () => {
  it("holds the root license to MIT", () => {
    const manifest = JSON.parse(read("package.json")) as { license?: unknown };
    expect(manifest.license).toBe("MIT");
    const license = read("LICENSE");
    expect(license.split("\n")[0]).toBe("MIT License");
    expect(words(license)).toBe(words(MIT_TEXT));
  });
});
