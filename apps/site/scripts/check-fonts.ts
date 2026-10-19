import { createHash } from "node:crypto";
import { cssRules, declarations } from "./lib/css.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** One self-hosted font file and where it came from (src/assets/fonts.json). */
export interface FontFile {
  file: string;
  family: string;
  weight: number;
  from: string;
  fromSha256: string;
  bytes: number;
  sha256: string;
}
/** One upstream release archive and its license file. */
export interface FontSource {
  family: string;
  version: string;
  archive: string;
  archiveSha256: string;
  license: string;
  licenseSha256: string;
  layoutFeatures: string;
}
export interface FontManifest {
  tool: string;
  read: string;
  unicodes: string;
  sources: FontSource[];
  files: FontFile[];
}

/** Hosts that serve fonts. No page and no style sheet of the build names one (brand spec 5). */
export const FONT_HOSTS =
  /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|p\.typekit\.net|fonts\.bunny\.net|rsms\.me|api\.fontshare\.com|fonts\.cdnfonts\.com/;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function checkFonts(input: {
  manifest: FontManifest;
  /** Each file of public/fonts/, by its name. */
  fontDir: ReadonlyMap<string, Uint8Array>;
  /** Each folder of public/fonts/, by its name. The loader reads no folder, so the runner does not throw. */
  fontFolders: readonly string[];
  tokensCss: string;
  /** Each .css, .html, and .js file of dist, by its path. */
  built: ReadonlyMap<string, string>;
  distFiles: ReadonlySet<string>;
}): CheckReport {
  const r: CheckReport = {
    name: "check-fonts",
    counts: { fonts: 0, licenses: 0, faces: 0, built: input.built.size },
    failures: [],
  };
  const files = new Map(input.manifest.files.map((f) => [f.file, f]));
  for (const f of input.manifest.files) {
    const bytes = input.fontDir.get(f.file);
    if (bytes === undefined) r.failures.push(`public/fonts/${f.file} is missing`);
    else if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256)
      r.failures.push(
        `public/fonts/${f.file} is not the file of fonts.json (bytes or SHA-256 differ)`,
      );
    else r.counts.fonts = (r.counts.fonts ?? 0) + 1;
    if (!input.distFiles.has(`fonts/${f.file}`)) r.failures.push(`dist/fonts/${f.file} is missing`);
  }
  for (const s of input.manifest.sources) {
    const bytes = input.fontDir.get(s.license);
    if (bytes === undefined || sha256(bytes) !== s.licenseSha256)
      r.failures.push(
        `public/fonts/${s.license} is missing or is not the license of ${s.family} ${s.version}`,
      );
    else r.counts.licenses = (r.counts.licenses ?? 0) + 1;
  }
  // Astro copies every file of public/ to dist, so a stray file of any format
  // ships. The folder holds the files of the record and the licenses only.
  const allowed = new Set([...files.keys(), ...input.manifest.sources.map((s) => s.license)]);
  for (const name of input.fontDir.keys())
    if (!allowed.has(name)) r.failures.push(`public/fonts/${name} is not in fonts.json`);
  for (const name of input.fontFolders)
    r.failures.push(`public/fonts/${name} is a folder, and fonts.json names files only`);
  const faced = new Set<string>();
  for (const x of cssRules(input.tokensCss)) {
    if (x.selector !== "@font-face") continue;
    const d = declarations(x.body);
    const file = /^url\("\/fonts\/([^"]+)"\) format\("woff2"\)$/.exec(d.get("src") ?? "")?.[1];
    const f = file === undefined ? undefined : files.get(file);
    if (f === undefined) {
      r.failures.push(
        `an @font-face names ${d.get("src") ?? "no src"}, which is not a file of fonts.json`,
      );
      continue;
    }
    r.counts.faces = (r.counts.faces ?? 0) + 1;
    faced.add(f.file);
    if (d.get("font-family") !== `"${f.family}"` || d.get("font-weight") !== String(f.weight))
      r.failures.push(`the @font-face of ${f.file} is not ${f.family} ${f.weight}`);
    if (d.get("font-display") !== "swap")
      r.failures.push(`the @font-face of ${f.file} lacks font-display: swap`);
  }
  for (const f of input.manifest.files)
    if (!faced.has(f.file)) r.failures.push(`tokens.css has no @font-face for ${f.file}`);
  for (const [path, text] of input.built) {
    const host = FONT_HOSTS.exec(text);
    if (host) r.failures.push(`${path} names the font host ${host[0]}`);
    for (const face of text.matchAll(/@font-face\s*\{([^}]*)\}/g))
      for (const u of (face[1] ?? "").matchAll(/url\(\s*["']?([^"')]+)/g)) {
        const url = u[1] ?? "";
        if (!url.startsWith("/fonts/") || !files.has(url.slice("/fonts/".length)))
          r.failures.push(`${path} loads the font ${url}, which is not a file of fonts.json`);
      }
  }
  return requireCounts(r, ["fonts", "licenses", "faces", "built"]);
}
