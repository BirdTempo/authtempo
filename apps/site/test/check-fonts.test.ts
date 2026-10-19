import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkFonts, type FontManifest } from "../scripts/check-fonts.ts";
import { fontDir, isBuiltText } from "../scripts/lib/load.ts";
import { SITE } from "../scripts/lib/paths.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const font = enc("font bytes");
const license = enc("license text");
const manifest: FontManifest = {
  tool: "pyftsubset",
  read: "2026-10-15",
  unicodes: "U+0000-00FF",
  sources: [
    {
      family: "Inter",
      version: "4.1",
      archive: "https://example.invalid/Inter.zip",
      archiveSha256: "0",
      license: "Inter-LICENSE.txt",
      licenseSha256: sha(license),
      layoutFeatures: "kern",
    },
  ],
  files: [
    {
      file: "inter-400.woff2",
      family: "Inter",
      weight: 400,
      from: "Inter-Regular.ttf",
      fromSha256: "0",
      bytes: font.length,
      sha256: sha(font),
    },
  ],
};
const face =
  '@font-face { font-family: "Inter"; font-weight: 400; font-display: swap; src: url("/fonts/inter-400.woff2") format("woff2"); }';
const input = () => ({
  manifest,
  fontDir: new Map([
    ["inter-400.woff2", font],
    ["Inter-LICENSE.txt", license],
  ]),
  fontFolders: [] as string[],
  tokensCss: face,
  built: new Map([["_astro/a.css", '@font-face{src:url(/fonts/inter-400.woff2) format("woff2")}']]),
  distFiles: new Set(["fonts/inter-400.woff2"]),
});

describe("checkFonts", () => {
  it("passes a font with its record, its license, and its face", () => {
    const r = checkFonts(input());
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ fonts: 1, licenses: 1, faces: 1, built: 1 });
  });

  it("fails a font file whose bytes differ from the record", () => {
    const i = input();
    i.fontDir.set("inter-400.woff2", enc("other bytes"));
    expect(checkFonts(i).failures).toContain(
      "public/fonts/inter-400.woff2 is not the file of fonts.json (bytes or SHA-256 differ)",
    );
  });

  it("fails a font file that public/fonts lacks", () => {
    const i = input();
    i.fontDir.delete("inter-400.woff2");
    expect(checkFonts(i).failures).toEqual([
      "public/fonts/inter-400.woff2 is missing",
      "read 0 fonts",
    ]);
  });

  it("fails a font file that dist lacks", () => {
    const i = { ...input(), distFiles: new Set<string>() };
    expect(checkFonts(i).failures).toEqual(["dist/fonts/inter-400.woff2 is missing"]);
  });

  it("fails a missing license file", () => {
    const i = input();
    i.fontDir.delete("Inter-LICENSE.txt");
    expect(checkFonts(i).failures).toContain(
      "public/fonts/Inter-LICENSE.txt is missing or is not the license of Inter 4.1",
    );
  });

  it("fails a font file that the record lacks", () => {
    const i = input();
    i.fontDir.set("extra.woff2", font);
    expect(checkFonts(i).failures).toEqual(["public/fonts/extra.woff2 is not in fonts.json"]);
  });

  it("fails a stray file of another format that the record lacks", () => {
    const i = input();
    i.fontDir.set("Inter-Bold.ttf", font);
    expect(checkFonts(i).failures).toEqual(["public/fonts/Inter-Bold.ttf is not in fonts.json"]);
  });

  it("fails a folder under public/fonts", () => {
    const i = { ...input(), fontFolders: ["sub"] };
    expect(checkFonts(i).failures).toEqual([
      "public/fonts/sub is a folder, and fonts.json names files only",
    ]);
  });

  it("fails a face for a file that the record lacks", () => {
    const other = face.replace("inter-400", "inter-700");
    const i = { ...input(), tokensCss: `${face}\n${other}` };
    expect(checkFonts(i).failures).toEqual([
      'an @font-face names url("/fonts/inter-700.woff2") format("woff2"), which is not a file of fonts.json',
    ]);
  });

  it("fails a record file with no face", () => {
    const i = { ...input(), tokensCss: "" };
    expect(checkFonts(i).failures).toEqual([
      "tokens.css has no @font-face for inter-400.woff2",
      "read 0 faces",
    ]);
  });

  it("fails a face whose family or weight differs from the record", () => {
    const weight = { ...input(), tokensCss: face.replace("font-weight: 400", "font-weight: 700") };
    expect(checkFonts(weight).failures).toEqual([
      "the @font-face of inter-400.woff2 is not Inter 400",
    ]);
    const family = { ...input(), tokensCss: face.replace('"Inter"', '"Other"') };
    expect(checkFonts(family).failures).toEqual([
      "the @font-face of inter-400.woff2 is not Inter 400",
    ]);
  });

  it("fails a face with no font-display swap", () => {
    const i = { ...input(), tokensCss: face.replace("font-display: swap; ", "") };
    expect(checkFonts(i).failures).toEqual([
      "the @font-face of inter-400.woff2 lacks font-display: swap",
    ]);
  });

  it("fails a page that names a font host", () => {
    const i = input();
    i.built.set("index.html", '<link href="https://fonts.googleapis.com/css2?family=Inter">');
    expect(checkFonts(i).failures).toEqual(["index.html names the font host fonts.googleapis.com"]);
  });

  it("fails a built script that names a font host", () => {
    const i = input();
    i.built.set(
      "_astro/page.js",
      'new FontFace("Inter", "url(https://fonts.gstatic.com/s/i.woff2)")',
    );
    expect(checkFonts(i).failures).toEqual([
      "_astro/page.js names the font host fonts.gstatic.com",
    ]);
  });

  it("fails a built face that loads a font of another place", () => {
    const i = input();
    i.built.set("_astro/b.css", "@font-face{src:url(https://cdn.example/x.woff2)}");
    expect(checkFonts(i).failures).toEqual([
      "_astro/b.css loads the font https://cdn.example/x.woff2, which is not a file of fonts.json",
    ]);
  });

  it("passes the five fonts and two licenses of the site", () => {
    const real = JSON.parse(readFileSync(`${SITE}src/assets/fonts.json`, "utf8")) as FontManifest;
    const dir = fontDir();
    expect(dir.folders).toEqual([]);
    const r = checkFonts({
      manifest: real,
      fontDir: dir.files,
      fontFolders: dir.folders,
      tokensCss: readFileSync(`${SITE}src/styles/tokens.css`, "utf8"),
      built: new Map([["empty.css", ""]]),
      distFiles: new Set(real.files.map((f) => `fonts/${f.file}`)),
    });
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ fonts: 5, licenses: 2, faces: 5, built: 1 });
  });

  it("fails on an empty record", () => {
    const empty: FontManifest = { tool: "", read: "", unicodes: "", sources: [], files: [] };
    const r = checkFonts({
      ...input(),
      manifest: empty,
      fontDir: new Map(),
      tokensCss: "",
      built: new Map([["empty.css", ""]]),
    });
    expect(r.failures).toEqual(["read 0 fonts", "read 0 licenses", "read 0 faces"]);
  });
});

describe("the built texts of dist", () => {
  it("reads the style sheets, the pages, and the scripts, and no font file", () => {
    expect(isBuiltText("_astro/common.b1qFdsOW.css")).toBe(true);
    expect(isBuiltText("docs/index.html")).toBe(true);
    expect(isBuiltText("_astro/page.abc123.js")).toBe(true);
    expect(isBuiltText("fonts/inter-400.woff2")).toBe(false);
  });
});
