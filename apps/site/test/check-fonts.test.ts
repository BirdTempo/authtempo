import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkFonts, type FontManifest } from "../scripts/check-fonts.ts";
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

  it("fails a built face that loads a font of another place", () => {
    const i = input();
    i.built.set("_astro/b.css", "@font-face{src:url(https://cdn.example/x.woff2)}");
    expect(checkFonts(i).failures).toEqual([
      "_astro/b.css loads the font https://cdn.example/x.woff2, which is not a file of fonts.json",
    ]);
  });

  it("passes the five fonts and two licenses of the site", () => {
    const real = JSON.parse(readFileSync(`${SITE}src/assets/fonts.json`, "utf8")) as FontManifest;
    const dir = `${SITE}public/fonts/`;
    const r = checkFonts({
      manifest: real,
      fontDir: new Map(
        readdirSync(dir).map((n) => [n, new Uint8Array(readFileSync(`${dir}${n}`))]),
      ),
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
