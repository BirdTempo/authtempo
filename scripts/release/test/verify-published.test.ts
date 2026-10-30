import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLIC_REGISTRY } from "../src/lib/release-facts.ts";
import { releasedNames } from "../src/lib/released.ts";
import { summaryLine } from "../src/lib/report.ts";
import {
  attestationsUrl,
  entry,
  FALLBACK_FILE,
  type FallbackEntry,
  PROVENANCE_PREDICATE,
  provenanceWorkflow,
  purlOf,
  type RegistryGet,
  readVerifyInput,
  type VerifyInput,
  verifyPublished,
  versionUrl,
  WORKFLOW_PATH,
} from "../src/verify-published.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const NAMES = ["@authtempo/cli", "@authtempo/core"];
/** The repository of release/repository.json. */
const REPOSITORY = "https://github.com/BirdTempo/authtempo";
/** The source facts of each run. */
const SOURCE = { repository: REPOSITORY, workflow: WORKFLOW_PATH };
const verify = (input: Omit<VerifyInput, "repository" | "workflow">) =>
  verifyPublished({ ...SOURCE, ...input });

/**
 * The attestations answer of a version, in the form of the registry (zod
 * 4.6.6 and @sveltejs/kit 3.0.1, read 2026-10-30 04:33 UTC): the publish
 * attestation of npm and the SLSA one, each with an in-toto statement as the
 * base64 payload of its DSSE envelope. Fields that the check does not read
 * are left out.
 */
const bundle = (
  name: string,
  version: string,
  workflow: Record<string, unknown> = {
    ref: `refs/tags/v${version}`,
    repository: REPOSITORY,
    path: WORKFLOW_PATH,
  },
) => {
  const envelope = (statement: unknown) => ({
    dsseEnvelope: {
      payloadType: "application/vnd.in-toto+json",
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    },
  });
  const subject = [{ name: purlOf(name, version), digest: { sha512: "0".repeat(128) } }];
  const publish = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
  return {
    attestations: [
      {
        predicateType: publish,
        bundle: envelope({ predicateType: publish, subject, predicate: { name, version } }),
      },
      {
        predicateType: PROVENANCE_PREDICATE,
        bundle: envelope({
          _type: "https://in-toto.io/Statement/v1",
          predicateType: PROVENANCE_PREDICATE,
          subject,
          predicate: { buildDefinition: { externalParameters: { workflow } } },
        }),
      },
    ],
  };
};

/**
 * The version document of a name with provenance, in the form of the
 * registry (zod 4.6.6, read 2026-10-30 03:13 UTC). Fields that the check
 * does not read are left out.
 */
const attested = (name: string, version: string) => ({
  name,
  version,
  dist: {
    attestations: {
      url: `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace("/", "%2f")}@${version}`,
      provenance: { predicateType: PROVENANCE_PREDICATE },
    },
  },
});

/** The document of a name with no provenance: dist has no attestations (postgres 3.4.9). */
const bare = (name: string, version: string) => ({ name, version, dist: { fileCount: 3 } });

/** A fake registry: each URL gets the answer of `answer`, and each call is recorded. */
function fake(answer: (url: string) => { status: number; body?: unknown } | Error) {
  const urls: string[] = [];
  const get: RegistryGet = async (url, init) => {
    urls.push(url);
    expect(init.headers).toEqual({ accept: "application/json" });
    const a = answer(url);
    if (a instanceof Error) throw a;
    return { status: a.status, json: async () => a.body };
  };
  return { urls, get };
}

/** The prefix of an attestations URL of the public registry. */
const ATTESTATIONS = `${PUBLIC_REGISTRY}-/npm/v1/attestations/`;

/** The name and version of a version URL or an attestations URL of the public registry, and its kind. */
const specOf = (url: string) => {
  if (url.startsWith(ATTESTATIONS)) {
    const spec = url.slice(ATTESTATIONS.length).replace("%2f", "/");
    const at = spec.lastIndexOf("@");
    return { kind: "attestations", name: spec.slice(0, at), version: spec.slice(at + 1) };
  }
  const [scoped = "", version = ""] = url.slice(PUBLIC_REGISTRY.length).split("/");
  return { kind: "version", name: scoped.replace("%2f", "/"), version };
};

const allAttested = () =>
  fake((url) => {
    const { kind, name, version } = specOf(url);
    return {
      status: 200,
      body: kind === "version" ? attested(name, version) : bundle(name, version),
    };
  });

const FALLBACK: FallbackEntry = {
  version: "0.1.0",
  date: "2026-11-02",
  reason: "npm offered no trusted publisher for a name with no version.",
};

describe("verify-published", () => {
  it("passes when each released name has a provenance attestation", async () => {
    const { urls, get } = allAttested();
    const r = await verify({ names: NAMES, version: "0.1.0", fallback: [], get });
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe(
      "verify-published: PASS packages=2 attested=2 fallback=0 failures=0",
    );
    expect(urls).toEqual([
      "https://registry.npmjs.org/@authtempo%2fcli/0.1.0",
      "https://registry.npmjs.org/-/npm/v1/attestations/@authtempo%2fcli@0.1.0",
      "https://registry.npmjs.org/@authtempo%2fcore/0.1.0",
      "https://registry.npmjs.org/-/npm/v1/attestations/@authtempo%2fcore@0.1.0",
    ]);
    expect(versionUrl(PUBLIC_REGISTRY, "zod", "4.6.6")).toBe(
      "https://registry.npmjs.org/zod/4.6.6",
    );
    // The forms of the registry, read 2026-10-30 04:33 UTC.
    expect(attestationsUrl(PUBLIC_REGISTRY, "@sveltejs/kit", "3.0.1")).toBe(
      "https://registry.npmjs.org/-/npm/v1/attestations/@sveltejs%2fkit@3.0.1",
    );
    expect(purlOf("@sveltejs/kit", "3.0.1")).toBe("pkg:npm/%40sveltejs/kit@3.0.1");
    expect(purlOf("zod", "4.6.6")).toBe("pkg:npm/zod@4.6.6");
  });

  it("holds each attestation to the repository, the workflow, and the package (ruling 52)", async () => {
    const run = async (body: (name: string, version: string) => unknown) => {
      const { get } = fake((url) => {
        const { kind, name, version } = specOf(url);
        return {
          status: 200,
          body: kind === "version" ? attested(name, version) : body(name, version),
        };
      });
      return (await verify({ names: ["@authtempo/core"], version: "0.1.0", fallback: [], get }))
        .failures;
    };
    const at = "@authtempo/core@0.1.0";
    // A type-only check passed each of these.
    expect(
      await run((n, v) =>
        bundle(n, v, { repository: "https://github.com/other/fork", path: WORKFLOW_PATH }),
      ),
    ).toEqual([
      `${at}: the provenance names the repository https://github.com/other/fork, not ${REPOSITORY}`,
    ]);
    expect(
      await run((n, v) =>
        bundle(n, v, { repository: REPOSITORY, path: ".github/workflows/ci.yml" }),
      ),
    ).toEqual([
      `${at}: the provenance names the workflow .github/workflows/ci.yml, not ${WORKFLOW_PATH}`,
    ]);
    expect(await run((_n, v) => bundle("@authtempo/client", v))).toEqual([
      `${at}: the statement names pkg:npm/%40authtempo/client@0.1.0, not pkg:npm/%40authtempo/core@0.1.0`,
    ]);
    expect(await run(() => ({ attestations: [] }))).toEqual([
      `${at}: the attestations answer holds 0 provenance attestations, not 1`,
    ]);
    expect(await run((n, v) => bundle(n, v, {}))).toEqual([
      `${at}: the statement names no workflow repository and path`,
    ]);
    expect(provenanceWorkflow(null, "x")).toBe("the attestations answer has no attestations list");
    expect(
      provenanceWorkflow(
        {
          attestations: [
            { predicateType: PROVENANCE_PREDICATE, bundle: { dsseEnvelope: { payload: "e30" } } },
          ],
        },
        "x",
      ),
    ).toBe("the statement has the predicate undefined");
  });

  it("reads the attestations only at the url of the registry, and fails no answer there", async () => {
    const moved = fake((url) => {
      const { kind, name, version } = specOf(url);
      if (kind !== "version") return { status: 200, body: bundle(name, version) };
      const doc = attested(name, version);
      doc.dist.attestations.url = "https://attestations.example/core";
      return { status: 200, body: doc };
    });
    expect(
      (await verify({ names: ["@authtempo/core"], version: "0.1.0", fallback: [], get: moved.get }))
        .failures,
    ).toEqual([
      "@authtempo/core@0.1.0: the attestations url is https://attestations.example/core, not https://registry.npmjs.org/-/npm/v1/attestations/@authtempo%2fcore@0.1.0",
    ]);
    expect(moved.urls).toHaveLength(1);
    const down = fake((url) => {
      const { kind, name, version } = specOf(url);
      if (kind === "version") return { status: 200, body: attested(name, version) };
      return name === "@authtempo/cli" ? { status: 500 } : new Error("socket hang up");
    });
    expect(
      (await verify({ names: NAMES, version: "0.1.0", fallback: [], get: down.get })).failures,
    ).toEqual([
      "@authtempo/cli@0.1.0: the registry answered status 500 for the attestations",
      "@authtempo/core@0.1.0: no answer from the registry for the attestations is not a pass: socket hang up",
    ]);
  });

  it("fails a name with no attestation, or with another predicate", async () => {
    const { get } = fake((url) => {
      const { name, version } = specOf(url);
      if (name === "@authtempo/cli") return { status: 200, body: bare(name, version) };
      const doc = attested(name, version);
      doc.dist.attestations.provenance.predicateType = "https://slsa.dev/provenance/v0.2";
      return { status: 200, body: doc };
    });
    const r = await verify({ names: NAMES, version: "0.1.0", fallback: [], get });
    expect(r.failures).toEqual([
      "@authtempo/cli@0.1.0: the registry holds no provenance attestation",
      "@authtempo/core@0.1.0: the provenance predicate is https://slsa.dev/provenance/v0.2, not https://slsa.dev/provenance/v1",
    ]);
    expect(summaryLine(r)).toBe(
      "verify-published: FAIL packages=2 attested=0 fallback=0 failures=2",
    );
  });

  it("fails a missing version, a bad status, a document of another version, and no answer", async () => {
    const { get } = fake((url) => {
      const { name } = specOf(url);
      if (name === "@authtempo/a") return { status: 404, body: "Not Found" };
      if (name === "@authtempo/b") return { status: 503 };
      if (name === "@authtempo/c") return { status: 200, body: attested(name, "0.0.9") };
      return new Error("connect ECONNREFUSED");
    });
    const r = await verify({
      names: ["@authtempo/a", "@authtempo/b", "@authtempo/c", "@authtempo/d"],
      version: "0.1.0",
      fallback: [],
      get,
    });
    expect(r.failures).toEqual([
      "@authtempo/a@0.1.0: the registry has no such version",
      "@authtempo/b@0.1.0: the registry answered status 503",
      "@authtempo/c@0.1.0: the registry answered the document of @authtempo/c@0.0.9",
      "@authtempo/d@0.1.0: no answer from the registry is not a pass: connect ECONNREFUSED",
    ]);
  });

  it("fails a read that takes longer than the limit", async () => {
    const get: RegistryGet = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const r = await verify({
      names: ["@authtempo/core"],
      version: "0.1.0",
      fallback: [],
      get,
      timeoutMs: 20,
    });
    expect(r.failures).toEqual([
      "@authtempo/core@0.1.0: no answer from the registry is not a pass: no answer in 20 ms",
    ]);
  });

  it("passes a missing attestation only for a version of the fallback file", async () => {
    const { get } = fake((url) => {
      const { name, version } = specOf(url);
      return { status: 200, body: bare(name, version) };
    });
    const listed = await verify({
      names: NAMES,
      version: "0.1.0",
      fallback: [FALLBACK],
      get,
    });
    expect(summaryLine(listed)).toBe(
      "verify-published: PASS packages=2 attested=0 fallback=2 failures=0",
    );
    expect(listed.notes).toEqual([
      `${FALLBACK_FILE} lists 0.1.0 (2026-11-02: npm offered no trusted publisher for a name with no version.), so a missing attestation passes`,
    ]);
    const other = await verify({
      names: NAMES,
      version: "0.2.0",
      fallback: [FALLBACK],
      get,
    });
    expect(other.failures).toEqual([
      "@authtempo/cli@0.2.0: the registry holds no provenance attestation",
      "@authtempo/core@0.2.0: the registry holds no provenance attestation",
    ]);
    // Only no attestation at all is a fallback; another predicate fails at a listed version too (review N3).
    const v02 = fake((url) => {
      const { name, version } = specOf(url);
      const doc = attested(name, version);
      doc.dist.attestations.provenance.predicateType = "https://slsa.dev/provenance/v0.2";
      return { status: 200, body: doc };
    });
    expect(
      (
        await verify({
          names: ["@authtempo/core"],
          version: "0.1.0",
          fallback: [FALLBACK],
          get: v02.get,
        })
      ).failures,
    ).toEqual([
      "@authtempo/core@0.1.0: the provenance predicate is https://slsa.dev/provenance/v0.2, not https://slsa.dev/provenance/v1",
    ]);
  });

  it("fails a fallback entry with no real date, no reason, a bad version, or a version twice", async () => {
    const { urls, get } = allAttested();
    const r = await verify({
      names: NAMES,
      version: "0.1.0",
      fallback: [
        FALLBACK,
        { ...FALLBACK, date: "2026-02-30", reason: " " },
        { ...FALLBACK, version: "v0.2.0" },
      ],
      get,
    });
    expect(r.failures).toEqual([
      `${FALLBACK_FILE} entry 2: the version 0.1.0 is listed twice`,
      `${FALLBACK_FILE} entry 2: the date 2026-02-30 is not a real YYYY-MM-DD`,
      `${FALLBACK_FILE} entry 2: it has no reason`,
      `${FALLBACK_FILE} entry 3: the version v0.2.0 is not <major>.<minor>.<patch>`,
    ]);
    // A bad file stops the run before any read.
    expect(urls).toEqual([]);
  });

  it("fails the version 0.0.0, a version of another form, and no name", async () => {
    const { urls, get } = allAttested();
    const zero = await verify({ names: NAMES, version: "0.0.0", fallback: [], get });
    expect(zero.failures).toEqual(["the group version is 0.0.0, so no release exists to verify"]);
    const pre = await verify({ names: NAMES, version: "0.1.0-next.1", fallback: [], get });
    expect(pre.failures).toEqual(["the version 0.1.0-next.1 is not <major>.<minor>.<patch>"]);
    expect(urls).toEqual([]);
    const none = await verify({ names: [], version: "0.1.0", fallback: [], get });
    expect(none.failures).toEqual(["read 0 packages"]);
  });

  it("notes a registry other than the public one", async () => {
    const { get } = fake((url) => {
      const [scoped = "", version = ""] = url.slice("http://127.0.0.1:9/".length).split("/");
      return { status: 200, body: attested(scoped.replace("%2f", "/"), version) };
    });
    // The check notes the other registry; each document there names the url of the public one, so it fails too.
    const r = await verify({
      names: NAMES,
      version: "0.1.0",
      fallback: [],
      get,
      registry: "http://127.0.0.1:9/",
    });
    expect(r.notes).toEqual([
      `the registry is http://127.0.0.1:9/, not ${PUBLIC_REGISTRY}: this run did not read npm`,
    ]);
  });
});

describe("the entry of verify-published", () => {
  it("reads every released name from releasedNames, and the group version", () => {
    const input = readVerifyInput(ROOT, undefined);
    expect(input.names).toEqual(releasedNames(ROOT));
    // The source of each attestation: release/repository.json and the release workflow.
    const repository = JSON.parse(
      readFileSync(new URL("../../../release/repository.json", import.meta.url), "utf8"),
    ) as { url: string };
    expect(input.repository).toBe(repository.url);
    expect(input.workflow).toBe(".github/workflows/release.yml");
    expect(input.names).toHaveLength(27);
    expect(input.version).toBe("0.0.0");
    expect(input.fallback).toEqual(
      JSON.parse(readFileSync(new URL(`../../../${FALLBACK_FILE}`, import.meta.url), "utf8")),
    );
    expect(readVerifyInput(ROOT, "0.1.0").version).toBe("0.1.0");
  });

  it("asks the registry for each released name at the given version", async () => {
    const { urls, get } = allAttested();
    const { lines, code } = await entry(ROOT, "0.1.0", get);
    expect(lines).toEqual(["verify-published: PASS packages=27 attested=27 fallback=0 failures=0"]);
    expect(code).toBe(0);
    expect(urls).toEqual(
      releasedNames(ROOT).flatMap((name) => [
        versionUrl(PUBLIC_REGISTRY, name, "0.1.0"),
        attestationsUrl(PUBLIC_REGISTRY, name, "0.1.0"),
      ]),
    );
  });

  it("fails at the group version of the tree today, 0.0.0, with no read", async () => {
    const { urls, get } = allAttested();
    const { lines, code } = await entry(ROOT, undefined, get);
    expect(lines).toEqual([
      "verify-published: FAIL packages=27 attested=0 fallback=0 failures=1",
      "  the group version is 0.0.0, so no release exists to verify",
    ]);
    expect(code).toBe(1);
    expect(urls).toEqual([]);
  });
});
