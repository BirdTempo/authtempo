import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The engine files of plan 12a whose limits the README "Account" table and the
// limits page state (plan 12a fix wave, Task 19 review I2). A number changed on
// one side only fails this test.
const ENGINE = [
  "reauth",
  "session-list",
  "profile",
  "email-change",
  "identities",
  "social",
  "account-delete",
  "passkeys",
];

type Limit = { seconds: number; max: number };

const UNIT: Readonly<Record<string, number>> = { minute: 60, hour: 3600, day: 86_400 };

/** Each limiter key of the engine files, by its `name:scope` prefix, with the constant it uses. */
function engineLimits(): Map<string, Limit> {
  const sources = ENGINE.map((f) =>
    readFileSync(`${REPO}packages/core/src/engine/${f}.ts`, "utf8"),
  );
  const constants = new Map<string, Limit>();
  for (const src of sources) {
    for (const m of src.matchAll(
      /const ([A-Z_]+_PER_(?:USER|IP)) = \{ seconds: (\d+), max: (\d+) \};/g,
    )) {
      constants.set(m[1] ?? "", { seconds: Number(m[2]), max: Number(m[3]) });
    }
  }
  const keys = new Map<string, Limit>();
  const used = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/allow\(\s*`([a-z-]+:[a-z]+):\$\{[^`]*`,\s*([A-Z_]+)\s*\)/g)) {
      const limit = constants.get(m[2] ?? "");
      if (!limit) continue;
      used.add(m[2] ?? "");
      keys.set(m[1] ?? "", limit);
    }
  }
  // A constant that no parsed limiter call uses means the parse missed a call.
  expect([...constants.keys()].filter((c) => !used.has(c))).toEqual([]);
  return keys;
}

/** The rows `| \`name:scope:<...>\` | N unit | max |` of a table, by key prefix. */
function rows(lines: readonly string[]): Map<string, Limit[]> {
  const out = new Map<string, Limit[]>();
  for (const l of lines) {
    const m = /^\| `([a-z-]+:[a-z]+):[^`]*` \| (\d+) (minute|hour|day)s? \| (\d+) \|/.exec(l);
    if (!m) continue;
    const limit = { seconds: Number(m[2]) * (UNIT[m[3] ?? ""] ?? 0), max: Number(m[4]) };
    out.set(m[1] ?? "", [...(out.get(m[1] ?? "") ?? []), limit]);
  }
  return out;
}

/** The lines after the line `from`, up to the next line that starts with `to`. */
function section(text: string, from: string, to: string): string[] {
  const lines = text.split("\n");
  const at = lines.indexOf(from);
  const end = lines.findIndex((l, i) => i > at && l.startsWith(to));
  if (at < 0) throw new Error(`no line "${from}"`);
  return lines.slice(at + 1, end < 0 ? undefined : end);
}

describe("the account limits of the engine", () => {
  const limits = engineLimits();
  const readme = rows(
    section(readFileSync(`${REPO}packages/core/README.md`, "utf8"), "## Account", "## "),
  );
  const page = rows(readFileSync(`${DOCS}docs/reference/limits.md`, "utf8").split("\n"));

  it("are the eleven keys of the eight engine files", () => {
    expect([...limits.keys()].sort()).toEqual([
      "email-change-confirm:ip",
      "email-change:user",
      "passkey-rename:user",
      "reauth-mail:user",
      "reauth:user",
      "session-revoke:user",
      "social-link:user",
      "unlink:user",
      "user-delete-confirm:ip",
      "user-delete:user",
      "user-update:user",
    ]);
  });

  it("have one row each, with the same window and count, in the core README and on the limits page", () => {
    for (const [key, limit] of limits) {
      expect({ key, readme: readme.get(key) }).toEqual({ key, readme: [limit] });
      expect({ key, page: page.get(key) }).toEqual({ key, page: [limit] });
    }
  });
});
