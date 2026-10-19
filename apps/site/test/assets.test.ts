import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIST, SITE } from "../scripts/lib/paths.ts";

interface AssetRecord {
  file: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}
const record = JSON.parse(readFileSync(`${SITE}src/assets/assets.json`, "utf8")) as {
  chrome: string;
  date: string;
  command: string;
  files: AssetRecord[];
};
/** Brand spec 3: the sizes of the three PNG files. */
const SIZES: Record<string, [number, number]> = {
  "apple-touch-icon.png": [180, 180],
  "favicon-192.png": [192, 192],
  "og.png": [1200, 630],
};
const attr = (tag: string, k: string) => new RegExp(`\\s${k}="([^"]*)"`).exec(tag)?.[1];
const rects = (svg: string) => [...svg.matchAll(/<rect\b[^>]*>/g)].map((m) => m[0]);
const bars = (svg: string) =>
  rects(svg).map((tag) => ["x", "y", "width", "height", "rx"].map((k) => attr(tag, k)));
const classes = (svg: string) => rects(svg).map((tag) => attr(tag, "class"));
const read = (file: string) => readFileSync(`${SITE}${file}`, "utf8");

describe("the brand assets (brand spec 3)", () => {
  it("records the three PNG files", () => {
    expect(record.files.map((f) => f.file).sort()).toEqual(Object.keys(SIZES).sort());
  });

  it("holds each PNG file as recorded, at its size", () => {
    for (const f of record.files) {
      const bytes = readFileSync(`${SITE}public/${f.file}`);
      expect({ file: f.file, sha: createHash("sha256").update(bytes).digest("hex") }).toEqual({
        file: f.file,
        sha: f.sha256,
      });
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      const size = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
      expect([f.file, ...size]).toEqual([f.file, ...(SIZES[f.file] ?? [])]);
      // The record's own numbers are the file's numbers, so the record cannot lie.
      expect([f.file, f.width, f.height, f.bytes]).toEqual([f.file, ...size, bytes.length]);
    }
  });

  it("ships each PNG file and the manifest in the build", () => {
    for (const f of record.files) expect(existsSync(`${DIST}${f.file}`)).toBe(true);
    const manifest = JSON.parse(readFileSync(`${DIST}site.webmanifest`, "utf8")) as {
      name: string;
      theme_color: string;
      icons: { src: string }[];
    };
    expect(manifest.name).toBe("authtempo");
    expect(manifest.theme_color).toBe("#f6f5f2");
    expect(manifest.icons.map((i) => i.src)).toEqual(["/favicon-192.png", "/apple-touch-icon.png"]);
  });

  it("draws the same four bars in the mark, the wordmark, and the favicon", () => {
    const mark = bars(read("src/assets/mark.svg"));
    expect(mark).toEqual([
      ["3", "14", "3", "8", "1.5"],
      ["8", "9", "3", "13", "1.5"],
      ["13", "2", "3", "20", "1.5"],
      ["18", "11", "3", "11", "1.5"],
    ]);
    expect(bars(read("src/assets/wordmark.svg"))).toEqual(mark);
    expect(bars(read("public/favicon.svg"))).toEqual(mark);
  });

  it("gives the third bar alone the accent class", () => {
    const accent = [undefined, undefined, "at-mark-accent", undefined];
    expect(classes(read("src/assets/mark.svg"))).toEqual(accent);
    expect(classes(read("src/assets/wordmark.svg"))).toEqual(accent);
    expect(classes(read("public/favicon.svg"))).toEqual([
      undefined,
      undefined,
      "accent",
      undefined,
    ]);
  });

  it("sets the wordmark text in Inter 600 at 22 units, 10 units after the mark", () => {
    const text = /<text\b[^>]*>authtempo<\/text>/.exec(read("src/assets/wordmark.svg"))?.[0] ?? "";
    expect(
      ["x", "y", "font-family", "font-weight", "font-size", "letter-spacing"].map((k) =>
        attr(text, k),
      ),
    ).toEqual(["31", "22", "Inter, sans-serif", "600", "22", "-0.44"]);
  });
});
