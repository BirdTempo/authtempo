import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SOURCES } from "../../scripts/copy-assets.mjs";
import { cutTokens } from "../../src/browser/cut.ts";
import { escapeHtml, html, PAGE_HEADERS, PAGE_POLICY } from "../../src/html.ts";
import { DEMO_PAGES } from "../../src/pages/layout.ts";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = resolve(PKG, "../..");
const POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'";

/** The rules of a _headers file: each path line with its indented "Name: value" lines. */
function rules(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      out.set(line.trim(), current);
      continue;
    }
    const at = line.indexOf(":");
    if (current === null || at < 0) throw new Error(`bad _headers line: ${line}`);
    current.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return out;
}

describe("the page rules", () => {
  it("holds PAGE_POLICY and the page headers to the brief", () => {
    expect(PAGE_POLICY).toBe(POLICY);
    expect(PAGE_HEADERS).toEqual({
      "content-security-policy": POLICY,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
  });

  it("sets the CSP and nosniff on /assets/* and /fonts/* in public/_headers", () => {
    const found = rules(readFileSync(join(PKG, "public/_headers"), "utf8"));
    expect([...found.keys()]).toEqual(["/assets/*", "/fonts/*"]);
    for (const [path, headers] of found)
      expect(Object.fromEntries(headers), path).toEqual({
        "content-security-policy": POLICY,
        "x-content-type-options": "nosniff",
      });
  });

  it("styles the pages with the tokens of tokens.css and no literal color", () => {
    const css = readFileSync(join(PKG, "public/assets/demo.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const tokens = readFileSync(join(REPO, "apps/site/src/styles/tokens.css"), "utf8");
    const defined = new Set([...tokens.matchAll(/(--at-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] ?? "");
    expect(used.length).toBeGreaterThan(30);
    expect(used.filter((t) => !defined.has(t))).toEqual([]);
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(/gi)).toBeNull();
  });

  it("writes no markup from a browser module", () => {
    const dir = join(PKG, "src/browser");
    const names = readdirSync(dir).filter((n) => n.endsWith(".ts"));
    expect(names.length).toBe(11);
    for (const name of names) {
      const source = readFileSync(join(dir, name), "utf8");
      expect(
        source.match(
          /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/g,
        ),
        name,
      ).toBeNull();
    }
  });

  it("hashes each site file that the demo build copies", () => {
    // turbo.json is JSONC: drop each comment line before the parse.
    const text = readFileSync(join(REPO, "turbo.json"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const tasks = (JSON.parse(text) as { tasks: Record<string, { inputs?: string[] }> }).tasks;
    for (const task of ["@authtempo/demo#build", "@authtempo/demo#typecheck"]) {
      const inputs = tasks[task]?.inputs ?? [];
      expect(inputs, task).toContain("$TURBO_DEFAULT$");
      expect(inputs, task).toContain(`$TURBO_ROOT$/${relative(REPO, SOURCES.tokens)}`);
      expect(inputs, task).toContain(`$TURBO_ROOT$/${relative(REPO, SOURCES.fonts)}/*`);
    }
    expect(relative(REPO, SOURCES.tokens)).toBe("apps/site/src/styles/tokens.css");
    expect(relative(REPO, SOURCES.fonts)).toBe("apps/site/public/fonts");
  });

  it("names a page of the docs as the guide of each page", () => {
    const docs = join(REPO, "apps/site/src/content/docs");
    for (const p of DEMO_PAGES) {
      expect(p.guide, p.path).toMatch(/^https:\/\/authtempo\.com\/docs\/.*\/$/);
      const path = new URL(p.guide).pathname.replace(/\/$/, "");
      const found = [".md", ".mdx", "/index.md", "/index.mdx"].some((ext) =>
        existsSync(join(docs, `${path}${ext}`)),
      );
      expect(found, p.guide).toBe(true);
    }
  });
});

describe("html", () => {
  it("escapes each value", () => {
    const name = `<img src=x onerror="alert(1)"> & 'q'`;
    expect(html`<p title="${name}">${name}</p>`.__html).toBe(
      '<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;q&#39;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;q&#39;</p>',
    );
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });

  it("keeps a value that html made, and joins an array", () => {
    const inner = html`<b>${"x<y"}</b>`;
    expect(html`<p>${inner}${[html`<i>1</i>`, "<2>"]}${null}${undefined}${false}</p>`.__html).toBe(
      "<p><b>x&lt;y</b><i>1</i>&lt;2&gt;</p>",
    );
  });

  it("escapes an object with a __html key that html did not make", () => {
    const forged = { __html: "<script>x</script>" };
    expect(html`${forged}`.__html).toBe("[object Object]");
    expect(html`${[forged]}`.__html).not.toContain("<script>");
  });
});

describe("the print of the last call", () => {
  it("cuts each token value to its first 6 characters", () => {
    expect(
      cutTokens({
        token: "ts_abcdefghijkl",
        apiToken: { id: "tok1", name: "ci" },
        user: { id: "u1", email: "pat@example.com" },
        secret: "JBSWY3DPEHPK3PXP",
        uri: "otpauth://totp/x",
        backupCodes: ["abcd-efgh", "jkmn-pqrs"],
        twoFactor: { challenge: "tfc_1234567890", methods: ["totp"] },
        sessionToken: "short",
      }),
    ).toEqual({
      token: "ts_abc…",
      apiToken: { id: "tok1", name: "ci" },
      user: { id: "u1", email: "pat@example.com" },
      secret: "JBSWY3…",
      uri: "otpaut…",
      backupCodes: ["abcd-e…", "jkmn-p…"],
      twoFactor: { challenge: "tfc_12…", methods: ["totp"] },
      sessionToken: "short",
    });
  });
});
