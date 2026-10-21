import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPO } from "../scripts/lib/paths.ts";

// Ruling 11 q2 of plan 12h: each example Worker that sends events to Workers
// Logs keeps observability on and samples every request. A rate below 1 drops
// whole requests, and with them their sign-in events (OWASP ASVS 5.0.0 16.3.1).

/** JSONC to JSON: each comment goes, and a "//" inside a string stays. */
function stripComments(text: string): string {
  let out = "";
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') quote = false;
    } else if (c === '"') {
      quote = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return out;
}

/** Each example whose package depends on @authtempo/observe and has a wrangler.jsonc. */
function observedExamples(): string[] {
  return readdirSync(`${REPO}examples`)
    .filter((name) => existsSync(`${REPO}examples/${name}/wrangler.jsonc`))
    .filter((name) => {
      const pkg = JSON.parse(readFileSync(`${REPO}examples/${name}/package.json`, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      return pkg.dependencies?.["@authtempo/observe"] !== undefined;
    })
    .sort();
}

describe("the observability block of the example Workers", () => {
  it("finds the three example Workers that send events", () => {
    expect(observedExamples()).toEqual(["worker", "worker-d1", "worker-postgres"]);
  });

  it("turns observability on and samples every request in each one", () => {
    for (const name of observedExamples()) {
      const config = JSON.parse(
        stripComments(readFileSync(`${REPO}examples/${name}/wrangler.jsonc`, "utf8")),
      ) as { observability?: unknown };
      expect({ name, observability: config.observability }).toEqual({
        name,
        observability: { enabled: true, head_sampling_rate: 1 },
      });
    }
  });
});
