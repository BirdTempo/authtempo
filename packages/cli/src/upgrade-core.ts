import { isDeepStrictEqual } from "node:util";
import { Stop, UsageError } from "./errors.js";
import { type Fetcher, HostError, isLocalHost, withoutCredentials } from "./net.js";

/**
 * The rules of `authtempo upgrade` (spec 33 item 10), apart from the io:
 * the read of the app's package.json, the read of the registry, the plan,
 * and the rewrite of the file. `readApp`, `planUpgrade`, and `rewriteManifest`
 * are pure. `readRegistry` is the one network read, through the fetch seam.
 */

export const SCOPE = "@authtempo/";
export const CORE = "@authtempo/core";
export const COMPAT = "@authtempo/compat-better-auth";
/** The alias of an app that moved from Better Auth (spec 23): `"better-auth": "npm:@authtempo/compat-better-auth@<v>"`. */
export const ALIAS_KEY = "better-auth";
const ALIAS_PREFIX = `npm:${COMPAT}@`;
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
/** The time limit of one registry read (spec 33 item 10.3). */
export const REGISTRY_TIMEOUT_MS = 10_000;
const SITE = "https://authtempo.com";
export const UPGRADES_PAGE = `${SITE}/docs/operations/upgrades/`;
export const CHANGELOG_PAGE = `${SITE}/docs/changelog/`;
/** The two lists that the command reads and writes, in this order. */
const SECTIONS = ["dependencies", "devDependencies"] as const;
type Section = (typeof SECTIONS)[number];

/** A version as the command takes it: an exact version, or one with a ^ or ~ in front. */
const VERSION_IN_APP = /^[\^~]?(\d+\.\d+\.\d+)$/;
/** A version of --to and of the registry: exact, with no tag. The program has no pre mode (spec 33 item 1.3). */
export const EXACT = /^\d+\.\d+\.\d+$/;

/** One entry of the app's package.json that the command moves. */
export interface AppEntry {
  section: Section;
  /** The key in the section: a package name, or `better-auth` for the alias. */
  key: string;
  /** The package on the registry: the key, or the compat package of the alias. */
  name: string;
  /** The text of the value, as the file holds it. */
  value: string;
  /** The exact version in the value. */
  version: string;
}

export interface AppManifest {
  path: string;
  entries: AppEntry[];
  /** The one version of the group in the app. */
  version: string;
}

/** The parts of a full registry document that the command reads (Task 10 Step 1). */
export interface RegistryDoc {
  name: string;
  distTags: Readonly<Record<string, string>>;
  /** Each version to its manifest, with its custom keys. */
  versions: Readonly<Record<string, Record<string, unknown>>>;
}

export interface UpgradePlan {
  from: string;
  to: string;
  /** True when the app is at the target: the command changes nothing. */
  current: boolean;
  packages: { name: string; from: string; to: string }[];
  /** Null when a core manifest of the registry names no schema version. */
  schema: { from: number; to: number; migrate: boolean } | null;
  /** Each crossed minor, in order, with the "Breaking:" lines of the target core. */
  breaking: { minor: string; lines: string[] }[];
  deprecations: { id: string; removeIn: string; docs: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The three numbers of an exact version. */
const parts = (v: string): [number, number, number] => {
  const [a = 0, b = 0, c = 0] = v.split(".").map(Number);
  return [a, b, c];
};

/** Below zero when a < b, zero when equal, above zero when a > b. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

const minorOf = (v: string) => v.split(".").slice(0, 2).join(".");

/**
 * The @authtempo entries of the text of a package.json (spec 33 item 10.1):
 * each @authtempo key of `dependencies` and `devDependencies`, and the
 * `better-auth` alias of the compat package. It stops on no entry, on a value
 * that is not a version, and on two versions of the group (item 10.2).
 */
export function readApp(text: string, path: string): AppManifest {
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    throw new Stop(`${path} is not JSON`);
  }
  if (!isRecord(pkg)) throw new Stop(`${path} is not a JSON object`);
  const entries: AppEntry[] = [];
  for (const section of SECTIONS) {
    const deps = pkg[section];
    if (!isRecord(deps)) continue;
    for (const [key, value] of Object.entries(deps)) {
      const alias =
        key === ALIAS_KEY && typeof value === "string" && value.startsWith(ALIAS_PREFIX);
      if (!key.startsWith(SCOPE) && !alias) continue;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const m = VERSION_IN_APP.exec(alias ? text.slice(ALIAS_PREFIX.length) : text);
      if (typeof value !== "string" || m?.[1] === undefined)
        throw new Stop(
          `${key} is ${JSON.stringify(text)} in ${section}; upgrade needs a version such as 0.1.0`,
        );
      entries.push({ section, key, name: alias ? COMPAT : key, value, version: m[1] });
    }
  }
  const first = entries[0];
  if (first === undefined) throw new Stop(`no @authtempo package in ${path}`);
  const other = entries.find((e) => e.version !== first.version);
  if (other !== undefined)
    throw new Stop(
      `two versions of the group in one app: ${first.key} ${first.version} and ${other.key} ${other.version}; set one version by hand, then run upgrade`,
    );
  return { path, entries, version: first.version };
}

/**
 * The base URL of the registry (`--registry`): https, or http on a host of
 * this machine for a local registry. No user part, no query, and no
 * fragment. The answer ends with a slash.
 */
export function registryBase(value: string | undefined): string {
  if (value === undefined) return DEFAULT_REGISTRY;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new UsageError(`--registry ${withoutCredentials(value)} is not a URL`);
  }
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "")
    throw new UsageError(
      `--registry ${withoutCredentials(value)} must have no user part, no query, and no fragment`,
    );
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u.hostname)))
    throw new UsageError(
      `--registry ${withoutCredentials(value)} must use https: http is for localhost, 127.0.0.1, or [::1] only`,
    );
  return u.href.endsWith("/") ? u.href : `${u.href}/`;
}

/** The URL of the full document of a package: the slash of the scope is %2f, as npm writes it. */
export const docUrl = (base: string, name: string) => `${base}${name.replace("/", "%2f")}`;

/**
 * One GET of the full registry document of `name` (spec 33 item 10.3). The
 * header `Accept: application/json` asks for the full document: the
 * abbreviated one drops the custom key `authtempo` (Task 10 Step 1). The read
 * stops after 10 s. The timer is a race, so a fetch that ignores its signal
 * cannot hold the command. The request follows no redirect, as every request
 * of the CLI.
 */
export async function readRegistry(
  ctx: { fetch: Fetcher },
  base: string,
  name: string,
  userAgent: string,
): Promise<RegistryDoc> {
  const url = docUrl(base, name);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => {
      controller.abort();
      fail(new HostError(`GET ${url}: no answer in ${REGISTRY_TIMEOUT_MS / 1000} s`));
    }, REGISTRY_TIMEOUT_MS);
  });
  let body: unknown;
  try {
    const answer = (async () => {
      let res: Response;
      try {
        res = await ctx.fetch(url, {
          method: "GET",
          headers: { accept: "application/json", "user-agent": userAgent },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        throw new HostError(`GET ${url}: no answer`);
      }
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))
        throw new HostError(
          `GET ${url} answered ${res.status}, a redirect: the CLI follows no redirect`,
        );
      if (res.status === 404) throw new Stop(`${name} is not on the registry ${base}`);
      if (res.status !== 200) throw new HostError(`GET ${url} answered ${res.status}`);
      try {
        return (await res.json()) as unknown;
      } catch {
        throw new Stop(`GET ${url} answered no JSON document`);
      }
    })();
    body = await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
  if (!isRecord(body) || !isRecord(body["dist-tags"]) || !isRecord(body.versions))
    throw new Stop(`the registry document of ${name} has no dist-tags or no versions`);
  const distTags: Record<string, string> = {};
  for (const [tag, v] of Object.entries(body["dist-tags"]))
    if (typeof v === "string") distTags[tag] = v;
  const versions: Record<string, Record<string, unknown>> = {};
  for (const [v, manifest] of Object.entries(body.versions))
    if (isRecord(manifest)) versions[v] = manifest;
  return { name, distTags, versions };
}

/** The `authtempo` key of core at `version`, or a stop when the registry lacks the version. */
function coreFactsOf(core: RegistryDoc, version: string): Record<string, unknown> | null {
  const manifest = core.versions[version];
  if (manifest === undefined) return null;
  return isRecord(manifest.authtempo) ? manifest.authtempo : {};
}

const schemaOf = (facts: Record<string, unknown> | null): number | null =>
  facts !== null && Number.isInteger(facts.schemaVersion) ? (facts.schemaVersion as number) : null;

/**
 * The plan of a run (spec 33 item 10), pure. The target is `to`, or the
 * `latest` dist-tag of core. It stops when the target is not on the
 * registry for each package, and on a downgrade. A crossed minor is each
 * minor above the installed one, up to the minor of the target. The
 * "Breaking:" lines and the deprecations come from the target core.
 */
export function planUpgrade(
  app: AppManifest,
  registry: Readonly<Record<string, RegistryDoc>>,
  options: { to?: string } = {},
): UpgradePlan {
  const core = registry[CORE];
  if (core === undefined) throw new Stop(`the registry has no document of ${CORE}`);
  const to = options.to ?? core.distTags.latest;
  if (to === undefined || !EXACT.test(to))
    throw new Stop(`${CORE} has no latest version on the registry`);
  const from = app.version;
  if (compareVersions(to, from) < 0)
    throw new Stop(`the target ${to} is below the installed ${from}`);
  if (to === from)
    return {
      from,
      to,
      current: true,
      packages: [],
      schema: null,
      breaking: [],
      deprecations: [],
    };
  for (const name of new Set([CORE, ...app.entries.map((e) => e.name)])) {
    const doc = registry[name];
    if (doc === undefined) throw new Stop(`the registry has no document of ${name}`);
    if (doc.versions[to] === undefined)
      throw new Stop(`${name} has no version ${to} on the registry`);
  }
  const target = coreFactsOf(core, to) ?? {};
  const installed = schemaOf(coreFactsOf(core, from));
  const next = schemaOf(target);
  const schema =
    installed === null || next === null
      ? null
      : { from: installed, to: next, migrate: installed !== next };

  // Each minor in (from, to], from the versions of core and the keys of breaking.
  const lines = isRecord(target.breaking) ? target.breaking : {};
  const minors = new Set<string>();
  for (const v of [...Object.keys(core.versions), ...Object.keys(lines).map((m) => `${m}.0`)])
    if (EXACT.test(v) && compareVersions(`${minorOf(v)}.0`, `${minorOf(from)}.0`) > 0)
      if (compareVersions(`${minorOf(v)}.0`, `${minorOf(to)}.0`) <= 0) minors.add(minorOf(v));
  const breaking = [...minors]
    .sort((a, b) => compareVersions(`${a}.0`, `${b}.0`))
    .map((minor) => {
      const list = lines[minor];
      return {
        minor,
        lines: Array.isArray(list) ? list.filter((l): l is string => typeof l === "string") : [],
      };
    });

  const deprecations: UpgradePlan["deprecations"] = [];
  for (const d of Array.isArray(target.deprecations) ? target.deprecations : []) {
    if (!isRecord(d)) continue;
    const { id, removeIn, docs } = d;
    if (typeof id !== "string" || typeof removeIn !== "string" || typeof docs !== "string")
      continue;
    if (!EXACT.test(removeIn)) continue;
    if (compareVersions(removeIn, from) > 0 && compareVersions(removeIn, to) <= 0)
      deprecations.push({ id, removeIn, docs });
  }

  return {
    from,
    to,
    current: false,
    packages: app.entries.map((e) => ({ name: e.key, from: e.version, to })),
    schema,
    breaking,
    deprecations,
  };
}

/** The value of an entry at the target: the alias keeps its prefix. A ^ or ~ goes: the value is exact (item 10.6). */
const valueAt = (e: AppEntry, to: string) =>
  e.value.startsWith(ALIAS_PREFIX) ? `${ALIAS_PREFIX}${to}` : to;

/**
 * The text of the package.json with each entry at `to` (spec 33 item 10.6).
 * Each change replaces the value string of its key in the text, so the key
 * order, the indent, and every other byte stay. The parse of the result must
 * equal the parse of the old text with only those values changed; else the
 * command stops and writes nothing.
 */
export function rewriteManifest(text: string, app: AppManifest, to: string): string {
  let out = text;
  const want = JSON.parse(text) as Record<string, Record<string, unknown>>;
  for (const e of app.entries) {
    const section = want[e.section];
    if (section !== undefined) section[e.key] = valueAt(e, to);
    const key = JSON.stringify(e.key).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const value = JSON.stringify(e.value).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    out = out.replace(
      new RegExp(`(${key}\\s*:\\s*)${value}`, "g"),
      (_, head: string) => `${head}${JSON.stringify(valueAt(e, to))}`,
    );
  }
  let got: unknown;
  try {
    got = JSON.parse(out);
  } catch {
    got = null;
  }
  if (!isDeepStrictEqual(got, want))
    throw new Stop(
      `${app.path}: the versions cannot change in place, because another key holds the same text; change them by hand`,
    );
  return out;
}

/** The install command of the lockfile in the app's folder, or null when it has none. */
export function installOf(exists: (name: string) => boolean): string | null {
  if (exists("pnpm-lock.yaml")) return "pnpm install";
  if (exists("package-lock.json")) return "npm install";
  if (exists("yarn.lock")) return "yarn install";
  if (exists("bun.lock") || exists("bun.lockb")) return "bun install";
  return null;
}
