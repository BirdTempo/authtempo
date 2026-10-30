import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { COMMON_OPTIONS, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { UPGRADE_HELP } from "../help/upgrade.js";
import type { UpgradeJson } from "../json.js";
import { printJson, sayer } from "../output.js";
import {
  CHANGELOG_PAGE,
  CORE,
  EXACT,
  installOf,
  planUpgrade,
  type RegistryDoc,
  readApp,
  readRegistry,
  registryBase,
  rewriteManifest,
  UPGRADES_PAGE,
} from "../upgrade-core.js";
import { CLI_VERSION } from "../version.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  to: { type: "string" },
  registry: { type: "string" },
  "dry-run": { type: "boolean", short: "n" },
} as const;

/** A docs path of the register as a link: the register holds a path of the site. */
const linkOf = (docs: string) => (docs.startsWith("/") ? `https://authtempo.com${docs}` : docs);

/**
 * `authtempo upgrade [dir] [--to <version>] [--registry <url>] [--dry-run]`
 * (plan 12j Task 10, spec 33 item 10). It moves every @authtempo package of
 * the app's package.json to one version, and prints the "Breaking:" lines,
 * the deprecations, and the next steps. It reads one full registry document
 * per package. It runs no install and no child process: a person reads each
 * "Breaking:" line before the install. Exit 1 tells that a crossed minor has
 * such a line; the file is still written. Exit 1 with no write tells that
 * the target core names no Breaking lines: "none" and "unknown" differ.
 */
export const upgradeCommand: Command = {
  help: UPGRADE_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    const { values: v, positionals } = parseOrUsage(
      () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
      Object.keys(OPTIONS),
    );
    if (positionals.length > 1)
      throw new UsageError(`upgrade takes one folder; got ${positionals.length}`);
    if (v.to !== undefined && !EXACT.test(v.to))
      throw new UsageError(`--to ${v.to} is not a version such as 0.2.0`);
    const base = registryBase(v.registry);
    const json = v.json === true;
    const dryRun = v["dry-run"] === true;
    const say = sayer(ctx, json);

    const dir = resolve(ctx.cwd, positionals[0] ?? ".");
    const path = join(dir, "package.json");
    if (!ctx.exists(path)) throw new Stop(`no package.json in ${dir}`);
    const text = ctx.readFile(path);
    const app = readApp(text, path);

    const registry: Record<string, RegistryDoc> = {};
    const agent = `authtempo/${CLI_VERSION}`;
    for (const name of new Set([CORE, ...app.entries.map((e) => e.name)]))
      registry[name] = await readRegistry(ctx, base, name, agent);
    const plan = planUpgrade(app, registry, v.to === undefined ? {} : { to: v.to });

    if (plan.current) {
      say(`the app is at ${plan.to}, the target: nothing to change`);
      if (json)
        printJson(ctx, {
          exit: 0,
          stopped: null,
          from: plan.from,
          to: plan.to,
          packages: [],
          schema: null,
          breaking: [],
          deprecations: [],
        } satisfies UpgradeJson);
      return 0;
    }

    // The write comes before the report: a stop in the rewrite prints no plan as done.
    const after = rewriteManifest(text, app, plan.to);
    if (!dryRun && plan.breakingKnown) ctx.replaceFile(path, after);

    say(`upgrade ${plan.from} to ${plan.to} in ${path}`);
    for (const p of plan.packages) say(`  ${p.name} ${p.from} to ${p.to} (${p.section})`);
    for (const p of plan.peers)
      say(
        p.holds === false
          ? `  peer ${p.name} ${p.range} excludes ${plan.to}: change the range by hand`
          : `  peer ${p.name} ${p.range}: upgrade cannot read the range; check that it holds ${plan.to}`,
      );
    for (const b of plan.breaking) {
      say(`${b.minor}: ${CHANGELOG_PAGE}`);
      for (const line of b.lines) say(`  ${line}`);
    }
    if (!plan.breakingKnown) {
      // No `authtempo.breaking` key: an empty list here would read as "no Breaking line".
      const unknown = `the registry names no Breaking lines for ${plan.to}: read the changelog of each crossed minor at ${CHANGELOG_PAGE}, then change the versions by hand`;
      say(unknown);
      say("wrote nothing");
      if (json)
        printJson(ctx, {
          exit: 1,
          stopped: unknown,
          from: plan.from,
          to: plan.to,
          packages: plan.packages,
          schema: plan.schema,
          breaking: plan.breaking,
          deprecations: plan.deprecations,
        } satisfies UpgradeJson);
      return 1;
    }
    for (const d of plan.deprecations) say(`removed in ${d.removeIn}: ${d.id}: ${linkOf(d.docs)}`);
    say(dryRun ? "dry run: wrote nothing" : `wrote ${path}`);
    const install = installOf(dir, (file) => ctx.exists(file));
    say(
      install === null
        ? "next: run the install of your package manager (no folder up to the root has a lockfile)"
        : install.dir === dir
          ? `next: ${install.command}`
          : `next: ${install.command} in ${install.dir}`,
    );
    // A core manifest with no schema version: the migrate step is the safe answer.
    if (plan.schema === null || plan.schema.migrate) {
      say(
        plan.schema === null
          ? "next: authtempo migrate (the registry names no schema version)"
          : `next: authtempo migrate (schema version ${plan.schema.from} to ${plan.schema.to})`,
      );
      say(`next: read ${UPGRADES_PAGE}`);
    }
    const breaks = plan.breaking.some((b) => b.lines.length > 0);
    if (breaks) say("read each Breaking line before the install");
    const exit = breaks ? 1 : 0;
    if (json)
      printJson(ctx, {
        exit,
        stopped: null,
        from: plan.from,
        to: plan.to,
        packages: plan.packages,
        schema: plan.schema,
        breaking: plan.breaking,
        deprecations: plan.deprecations,
      } satisfies UpgradeJson);
    return exit;
  },
};
