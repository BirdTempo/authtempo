// Draws the three PNG files of brand spec 3 once, from mark.svg, wordmark.svg,
// the paper, ink, and accent of tokens.css, the headline of HOME, and the
// Inter 600 file, with the Chrome of the machine that runs it. The site's
// build never runs this script, so the build has no image dependency. Run it
// by hand after a change of one of those inputs, and commit the PNG files
// with src/assets/assets.json, which records each SHA-256 for the test.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME } from "../src/data/home.ts";
import { SITE } from "./lib/paths.ts";
import { parseTokens } from "./lib/tokens.ts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const tokens = parseTokens(readFileSync(`${SITE}src/styles/tokens.css`, "utf8"));
const color = (name: string) => {
  const value = tokens.light.get(name);
  if (value === undefined) throw new Error(`tokens.css has no light ${name}`);
  return value;
};
const mark = readFileSync(`${SITE}src/assets/mark.svg`, "utf8");
const wordmark = readFileSync(`${SITE}src/assets/wordmark.svg`, "utf8");
const inter = pathToFileURL(`${SITE}public/fonts/inter-600.woff2`).href;
const base = [
  `@font-face{font-family:Inter;font-weight:600;src:url("${inter}") format("woff2")}`,
  `html,body{margin:0;background:${color("--at-paper")};color:${color("--at-ink")}}`,
  `.at-mark-accent{fill:${color("--at-accent")}}svg{display:block}`,
  ".og{padding:96px;font-family:Inter;font-weight:600}",
  ".og p{font-size:72px;line-height:1.05;letter-spacing:-0.03em;margin:120px 0 0;max-width:1008px}",
].join("\n");
const sized = (svg: string, w: number, h: number) =>
  svg.replace("<svg ", `<svg width="${w}" height="${h}" `);
// Chrome 155 headless lays the page out at least 500 px wide, whatever the
// window size, and the shot crops the window size from the top left (read
// 2026-10-19). So the pad of an icon is an eighth of the icon in pixels, not
// a percent of the page, and the mark fills the three quarters inside it.
const icon = (size: number) =>
  `<div style="padding:${size / 8}px">${sized(mark, size * 0.75, size * 0.75)}</div>`;
const PAGES = [
  {
    file: "favicon-192.png",
    width: 192,
    height: 192,
    body: icon(192),
  },
  {
    file: "apple-touch-icon.png",
    width: 180,
    height: 180,
    body: icon(180),
  },
  {
    file: "og.png",
    width: 1200,
    height: 630,
    body: `<div class="og">${sized(wordmark, 288, 56)}<p>${HOME.headline}</p></div>`,
  },
];

const version = spawnSync(CHROME, ["--version"], { encoding: "utf8" });
if (version.status !== 0) throw new Error(`no Chrome at ${CHROME}; set CHROME to its path`);
const dir = mkdtempSync(join(tmpdir(), "authtempo-assets-"));
const files = PAGES.map((p) => {
  const html = join(dir, `${p.file}.html`);
  writeFileSync(
    html,
    `<!doctype html><html><head><meta charset="utf-8"><style>${base}</style></head><body>${p.body}</body></html>`,
  );
  const png = `${SITE}public/${p.file}`;
  const run = spawnSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--force-device-scale-factor=1",
      // The page waits for the font file before the shot.
      "--virtual-time-budget=5000",
      `--window-size=${p.width},${p.height}`,
      `--screenshot=${png}`,
      pathToFileURL(html).href,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`Chrome failed on ${p.file}: ${run.stderr}`);
  const bytes = readFileSync(png);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { file: p.file, width: p.width, height: p.height, bytes: bytes.length, sha256 };
});
const out = {
  chrome: version.stdout.trim(),
  date: new Date().toISOString(),
  command: "node apps/site/scripts/render-assets.ts",
  files,
};
writeFileSync(`${SITE}src/assets/assets.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(`render-assets: wrote ${files.length} files with ${out.chrome}`);
