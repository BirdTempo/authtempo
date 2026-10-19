import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_CHECK_CODES } from "@authtempo/cli";
import { COMMANDS, PROVIDERS } from "@authtempo/cli/program";
import { beforeAll, describe, expect, it } from "vitest";
import { checkSentences } from "../../../apps/site/scripts/check-sentences.ts";
import { checkTerms } from "../../../apps/site/scripts/check-terms.ts";
import { idsOf } from "../../../apps/site/scripts/lib/html.ts";
import type { Page } from "../../../apps/site/scripts/lib/markdown.ts";
import type { AgentIndex } from "../src/index-format.js";
import { parseSkill } from "../src/prompts.js";
import { TOOLS } from "../src/tools.js";
import { PKG, REPO } from "./support/bin.js";
import { assertFreshIndex, siteIndex } from "./support/index.js";

// The skill pack of plan 11e Task 14. The rules come from their own sources.
// The frontmatter rules come from agentskills.io/specification (read
// 2026-10-14). The prose rules come from the site's checkSentences and
// checkTerms, the one source of the prose rules. The links come from the
// built site. Each named command, flag, and tool comes from the CLI and the
// tool table.

const SKILLS = join(PKG, "skills");

interface SkillFile {
  folder: string;
  source: string;
  /** The text after the frontmatter. */
  body: string;
}

/** Each folder of skills/ with its SKILL.md, read here with no code of src/. */
function skillFiles(): SkillFile[] {
  return readdirSync(SKILLS)
    .sort()
    .map((folder) => {
      const source = readFileSync(join(SKILLS, folder, "SKILL.md"), "utf8");
      const lines = source.split("\n");
      const end = lines.indexOf("---", 1);
      return { folder, source, body: lines.slice(end + 1).join("\n") };
    });
}

/** The top-level keys of a frontmatter, and the keys under metadata. */
function frontmatter(source: string): {
  top: Record<string, string>;
  metadata: Record<string, string>;
} {
  const lines = source.split("\n");
  const end = lines.indexOf("---", 1);
  const top: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const nested = /^ {2}([a-z_]+): (.*)$/.exec(line);
    if (nested) metadata[nested[1] ?? ""] = nested[2] ?? "";
    const kv = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (kv) top[kv[1] ?? ""] = kv[2] ?? "";
  }
  return { top, metadata };
}

/** The text of each code span of a body. */
const spans = (body: string): string[] => [...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");

let files: SkillFile[];
let index: AgentIndex;

beforeAll(() => {
  assertFreshIndex();
  index = siteIndex();
  files = skillFiles();
});

describe("the skill pack", () => {
  it("keeps the agentskills.io frontmatter rules", () => {
    expect(files.length).toBeGreaterThan(0);
    const pages = new Set(index.pages.map((p) => p.path));
    for (const f of files) {
      const where = `skills/${f.folder}`;
      expect(statSync(join(SKILLS, f.folder)).isDirectory(), where).toBe(true);
      const { top, metadata } = frontmatter(f.source);
      expect(Object.keys(top).sort(), where).toEqual(["description", "metadata", "name"]);
      expect(Object.keys(metadata), where).toEqual(["source"]);
      const name = top.name ?? "";
      // 1 to 64 characters of a-z, 0-9, and hyphens; no hyphen at an end, no two in a row.
      expect(name, where).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(name.length, where).toBeLessThanOrEqual(64);
      expect(name, `${where}: the name equals the folder`).toBe(f.folder);
      const description = top.description ?? "";
      expect(description.length, where).toBeGreaterThanOrEqual(1);
      expect(description.length, where).toBeLessThanOrEqual(1024);
      expect(f.body.split("\n").length, `${where}: the body is under 500 lines`).toBeLessThan(500);
      expect(pages.has(metadata.source ?? ""), `${where}: metadata.source is a page`).toBe(true);
      // The parts of the body: For, the prerequisites, numbered steps, If it fails, and Next.
      for (const part of [
        "**For:**",
        "## Before you start",
        "## Steps",
        "## If it fails",
        "## Next",
      ])
        expect(f.body, `${where} has ${part}`).toContain(part);
      expect(f.body, `${where} has numbered steps`).toMatch(/\n1\. \S/);
      expect(f.body, `${where} holds a placeholder`).not.toMatch(/\b(?:TODO|TBD|FIXME|XXX)\b/);
      // The server's own reader accepts it.
      expect(() => parseSkill({ name: f.folder, markdown: f.source }), where).not.toThrow();
    }
  });

  it("refuses a skill with a bad frontmatter, and names its path", () => {
    // A real skill with one frontmatter line changed, as an author can write it.
    const f = files.find((x) => x.folder === "authtempo-integrate-node");
    expect(f).toBeDefined();
    const source = f?.source ?? "";
    const where = /skills\/authtempo-integrate-node\/SKILL\.md: /;
    const bad = [
      source.replace(/^description: .*$/m, "description: "),
      source.replace(/^name: .*$/m, "name: Authtempo-Integrate-Node"),
      source.replace(/^metadata:$/m, "license: MIT\nmetadata:"),
      source.replace(/^ {2}source: .*$/m, "  source: docs/start/node"),
      source.replace(/^---\n/, ""),
      // Values that YAML reads another way, or refuses (agentskills.io clients read YAML).
      source.replace(/^description: /m, "description: Use it: "),
      source.replace(/^description: /m, "description: {"),
      source.replace(/^description: /m, 'description: "'),
      source.replace(/^description: /m, "description: # "),
    ];
    for (const markdown of bad) {
      expect(markdown).not.toBe(source);
      expect(() => parseSkill({ name: "authtempo-integrate-node", markdown })).toThrow(where);
    }
  });

  it("keeps the sentence and term rules of the site", () => {
    const pages: Page[] = files.map((f) => ({
      path: `skills/${f.folder}/SKILL.md`,
      source: f.source,
    }));
    const sentences = checkSentences(pages);
    expect(sentences.failures).toEqual([]);
    expect(sentences.counts.sentences ?? 0).toBeGreaterThan(0);
    // checkTerms holds the glossary to its own list, so the glossary page goes in too.
    const glossary = "docs/reference/glossary.md";
    const terms = checkTerms([
      ...pages,
      {
        path: glossary,
        source: readFileSync(join(REPO, "apps/site/src/content/docs", glossary), "utf8"),
      },
    ]);
    expect(terms.failures).toEqual([]);
    expect(terms.counts.units ?? 0).toBeGreaterThan(0);
  });

  it("links only pages and anchors of the build", () => {
    const pages = new Set(index.pages.map((p) => p.path));
    let links = 0;
    let anchors = 0;
    for (const f of files) {
      const found = [
        ...[...f.body.matchAll(/\]\((\/docs\/[^)\s]*)\)/g)].map((m) => m[1] ?? ""),
        ...spans(f.body).filter((s) => s.startsWith("/docs/")),
      ];
      expect(found.length, `skills/${f.folder} links no page`).toBeGreaterThan(0);
      for (const link of found) {
        const [path = "", anchor] = link.split("#");
        links++;
        expect(pages.has(path), `skills/${f.folder}: ${link} is no page of the index`).toBe(true);
        if (anchor === undefined) continue;
        anchors++;
        const sections = index.sections.filter((s) => s.path === path).map((s) => s.anchor);
        const html = readFileSync(join(REPO, "apps/site/dist", path, "index.html"), "utf8");
        expect(
          sections.includes(anchor) || idsOf(html).has(anchor),
          `skills/${f.folder}: ${link} names no anchor of the page`,
        ).toBe(true);
      }
    }
    expect(links).toBeGreaterThan(0);
    expect(anchors).toBeGreaterThan(0);
  });

  it("names only tools of the table, and commands and flags of the CLI", () => {
    const local = new Set(TOOLS.filter((t) => t.surfaces.includes("local")).map((t) => t.name));
    // The namespaces of the dotted tool names, such as docs and migrate.
    const namespaces = new Set(
      TOOLS.map((t) => t.name.split(".")).flatMap((p) => (p.length > 1 ? [p[0] ?? ""] : [])),
    );
    const packages = new Map<string, Record<string, unknown>>();
    for (const dir of readdirSync(join(REPO, "packages"))) {
      const file = join(REPO, "packages", dir, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name: string; exports?: object };
      packages.set(pkg.name, (pkg.exports ?? {}) as Record<string, unknown>);
    }
    let tools = 0;
    let commands = 0;
    for (const f of files) {
      const where = `skills/${f.folder}`;
      // A tool is named as "Call `name`", and a dotted name of a tool namespace is a tool too.
      const called = [...f.body.matchAll(/\b[Cc]all `([^`]+)`/g)].map((m) => m[1] ?? "");
      const dotted = spans(f.body).filter((s) => {
        const m = /^([a-z]+)\.[a-z_]+$/.exec(s);
        return m !== null && namespaces.has(m[1] ?? "");
      });
      expect(called.length, `${where} calls no tool`).toBeGreaterThan(0);
      for (const name of [...called, ...dotted]) {
        tools++;
        expect(local.has(name), `${where}: ${name} is no tool of the table`).toBe(true);
      }
      // In a line that calls a tool, some spans name a key of that tool. They
      // are a `key: value` span, each span after "Add the input", and each
      // span with an underscore. A bare span right after "with", "Pass", or
      // "the" is one too, and so is a span before "set to". A key is an input
      // key or an output key of the row.
      for (const line of f.body.split("\n")) {
        const tool = /\b[Cc]all `([^`]+)`/.exec(line)?.[1];
        const row = TOOLS.find((t) => t.name === tool);
        if (row === undefined) continue;
        const keys = [...Object.keys(row.input.shape), ...row.outputKeys];
        const given: string[] = [];
        for (const m of line.matchAll(/`([^`\n]+)`/g)) {
          const span = m[1] ?? "";
          if (span === tool) continue;
          const pair = /^([a-z_]+): /.exec(span);
          if (pair) {
            given.push(pair[1] ?? "");
            continue;
          }
          if (!/^[a-z_]+$/.test(span)) continue;
          const before = line.slice(0, m.index);
          const after = line.slice((m.index ?? 0) + m[0].length);
          const listed = /Add the inputs? /.test(before);
          const named = /(?:\bwith|\bPass|\bthe) $/.test(before) || after.startsWith(" set to");
          if (span.includes("_") || listed || named) given.push(span);
        }
        for (const key of given)
          expect(keys, `${where}: ${key} is no key of ${row.name}`).toContain(key);
      }
      for (const span of spans(f.body)) {
        if (span.startsWith("authtempo ")) {
          commands++;
          const [, command = "", ...rest] = span.split(/\s+/);
          expect(Object.hasOwn(COMMANDS, command), `${where}: ${span} names no command`).toBe(true);
          const options = COMMANDS[command]?.options ?? {};
          for (const token of rest.filter((t) => t.startsWith("--")))
            expect(
              Object.hasOwn(options, token.slice(2).split("=")[0] ?? ""),
              `${where}: ${token} is no flag of authtempo ${command}`,
            ).toBe(true);
        }
        // A path of the repo exists, and a package entry is an export of its package.
        if (/^(?:apps|examples|packages)\/[\w./-]+$/.test(span))
          expect(existsSync(join(REPO, span)), `${where}: ${span} does not exist`).toBe(true);
        const entry = /^(@authtempo\/[a-z0-9-]+)(\/[a-z0-9-]+)?$/.exec(span);
        if (entry) {
          const exports = packages.get(entry[1] ?? "");
          expect(exports, `${where}: ${span} is no package`).toBeDefined();
          expect(
            Object.hasOwn(exports ?? {}, `.${entry[2] ?? ""}`),
            `${where}: ${span} is no export of its package`,
          ).toBe(true);
        }
      }
    }
    expect(tools).toBeGreaterThan(0);
    expect(commands).toBeGreaterThan(0);
  });
  it("keeps the phases of each provider guide: the run, the sign-in, the calls, the cutover", () => {
    // Spec 23 item 9: "Verify" and "Change the calls" come between the move and the cutover.
    for (const provider of PROVIDERS) {
      const f = files.find((x) => x.folder === `authtempo-migrate-${provider}`);
      expect(f, provider).toBeDefined();
      const steps = (f?.body ?? "").split("\n").filter((l) => /^\d+\. /.test(l));
      const at = (re: RegExp) => steps.findIndex((l) => re.test(l));
      const run = at(/call `migrate\.run`/);
      const signIn = at(/^\d+\. Sign in once with a known user/);
      const calls = at(new RegExp(`\\]\\(/docs/migrate/${provider}/#the-calls\\)`));
      const cutover = at(/`\/docs\/migrate\/cutover\/`/);
      expect(
        [run, signIn, calls, cutover].every((i) => i >= 0),
        provider,
      ).toBe(true);
      expect(run < signIn && signIn < calls && calls < cutover, provider).toBe(true);
    }
    // The Cognito guide signs in a second time, with capital letters in the address.
    const cognito = files.find((x) => x.folder === "authtempo-migrate-cognito")?.body ?? "";
    expect(cognito).toMatch(
      /^\d+\. .*Sign in once more with a user whose Cognito address has capital letters\./m,
    );
  });

  it("links each check code of the CLI once in the check skill, and no other code", () => {
    // ALL_CHECK_CODES is the one list of the codes. The skill is a hand list,
    // so this test ties it to the list both ways (ruling 16 of plan 11c2).
    const f = files.find((x) => x.folder === "authtempo-check-deployment");
    expect(f).toBeDefined();
    const links = [
      ...(f?.body ?? "").matchAll(/\(\/docs\/reference\/cli\/check\/#([a-z_]+)\)/g),
    ].map((m) => m[1]);
    expect(new Set(links).size, "a code linked twice").toBe(links.length);
    expect([...links].sort()).toEqual([...ALL_CHECK_CODES].sort());
  });
});
