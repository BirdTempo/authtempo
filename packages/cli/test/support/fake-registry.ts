import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./bin.js";

/**
 * A fake npm registry for `authtempo upgrade` (plan 12j Task 10). Each
 * answer has the shape of the full registry document that Task 10 Step 1
 * read on 2026-10-30 (GET with `Accept: application/json`): `_id`, `_rev`,
 * `name`, `dist-tags`, `versions`, `time`, and the manifest keys of each
 * version, a custom key too. Core's custom key `authtempo` holds what
 * `prepare` writes into its packed manifest: `schemaVersion`, `breaking`
 * (each minor to its "Breaking:" lines), and `deprecations` (the register).
 */

/** The versions of the fake registry, in order, and the `latest` dist-tag. */
export const VERSIONS = ["0.1.0", "0.1.3", "0.2.0", "0.2.1", "0.3.0"] as const;
export const LATEST = "0.2.1";

/** The schema version of core at each version: 0.2.0 adds a migration. */
export const SCHEMA_OF: Readonly<Record<string, number>> = {
  "0.1.0": 15,
  "0.1.3": 15,
  "0.2.0": 16,
  "0.2.1": 16,
  "0.3.0": 16,
};

/** The "Breaking:" lines of each minor, as the changelog of core gives them. */
export const BREAKING: Readonly<Record<string, readonly string[]>> = {
  "0.2": [
    "Breaking: The session cookie is __Host-authtempo_session only. The read of tempo_session goes.",
    "Breaking: The handoff package no longer re-exports makePkce and webCrypto.",
  ],
  "0.3": ["Breaking: createAuth refuses a config with no app secret version."],
};

/** The register of the repository: the three items since 0.1.0, each removed in 0.2.0. */
const REGISTER = JSON.parse(readFileSync(join(REPO, "release/deprecations.json"), "utf8")) as {
  id: string;
  removeIn: string;
}[];

/** An entry that a later minor adds to the register: since 0.2.0, removed in 0.3.0. */
export const LATER_DEPRECATION = {
  id: "migrate-before-flag",
  what: "The flag --before-1.7 of authtempo migrate. The compat tables move with the core tables.",
  since: "0.2.0",
  removeIn: "0.3.0",
  markers: [{ file: "packages/cli/src/commands/migrate.ts", text: '"before-1.7"' }],
  docs: "/docs/reference/deprecations/#migrate-before-flag",
} as const;

const atOrBelow = (a: string, b: string) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return true;
};

/** The `authtempo` key of core at `version`: the facts of its own changelog and register. */
export function coreFacts(version: string): Record<string, unknown> {
  const breaking: Record<string, string[]> = {};
  for (const [minor, lines] of Object.entries(BREAKING))
    if (atOrBelow(`${minor}.0`, version)) breaking[minor] = [...lines];
  const deprecations: unknown[] = [...REGISTER];
  if (atOrBelow(LATER_DEPRECATION.since, version)) deprecations.push(LATER_DEPRECATION);
  return { schemaVersion: SCHEMA_OF[version], breaking, deprecations };
}

/** The full registry document of one package, with the keys that Step 1 recorded. */
export function registryDoc(
  name: string,
  o: { versions?: readonly string[]; latest?: string } = {},
): Record<string, unknown> {
  const list = o.versions ?? VERSIONS;
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = {
    created: "2026-11-02T10:00:00.000Z",
    modified: "2026-12-14T10:00:00.000Z",
  };
  list.forEach((v, i) => {
    const file = `${name.replace("@authtempo/", "")}-${v}.tgz`;
    versions[v] = {
      name,
      version: v,
      type: "module",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/BirdTempo/authtempo.git",
        directory: `packages/${name.replace("@authtempo/", "")}`,
      },
      engines: { node: ">=22" },
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      ...(name === "@authtempo/core" ? { authtempo: coreFacts(v) } : {}),
      _id: `${name}@${v}`,
      dist: {
        shasum: "0".repeat(40),
        tarball: `https://registry.npmjs.org/${name}/-/${file}`,
        integrity: `sha512-${"A".repeat(86)}==`,
      },
      _npmUser: { name: "birdtempo", email: "npm@birdtempo.example" },
      _hasShrinkwrap: false,
    };
    time[v] =
      `2026-${String(11 + Math.floor(i / 3)).padStart(2, "0")}-0${1 + (i % 3)}T10:00:00.000Z`;
  });
  return {
    _id: name,
    _rev: `${list.length}-0123456789abcdef0123456789abcdef`,
    name,
    "dist-tags": { latest: o.latest ?? LATEST },
    versions,
    time,
    license: "MIT",
    readme: `# ${name}\n`,
    readmeFilename: "README.md",
  };
}

/**
 * The fetch of a fake registry at `base`. A GET of `<base><name>`, with the
 * slash of the scope as %2f, answers the document of that name; any other
 * path answers 404 as the registry does. `silent` never answers: the promise
 * rejects only when the signal of the request aborts, as a real fetch does.
 */
export function fakeRegistry(
  o: {
    base?: string;
    docs?: Readonly<Record<string, Record<string, unknown>>>;
    silent?: boolean;
  } = {},
): (url: string, init: RequestInit) => Promise<Response> {
  const base = o.base ?? "https://registry.npmjs.org/";
  const names = [
    "@authtempo/core",
    "@authtempo/adapter-d1",
    "@authtempo/adapter-postgres",
    "@authtempo/cli",
    "@authtempo/compat-better-auth",
  ];
  const docs = o.docs ?? Object.fromEntries(names.map((n) => [n, registryDoc(n)]));
  return (url, init) => {
    if (o.silent === true)
      return new Promise((_, fail) => {
        init.signal?.addEventListener("abort", () => fail(init.signal?.reason));
      });
    const name = url.startsWith(base) ? decodeURIComponent(url.slice(base.length)) : "";
    const doc = Object.hasOwn(docs, name) ? docs[name] : undefined;
    if (doc === undefined)
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );
    return Promise.resolve(
      new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}
