import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_PAGES } from "../src/pages/layout.js";
import {
  call,
  lastCode,
  lastLink,
  newSandbox,
  ORIGIN,
  rowsIn,
  SANDBOX_COOKIE,
  sandboxId,
  signInByLink,
} from "./helpers.js";

const POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'";
const COST =
  "The demo hashes each password with 1000 PBKDF2 iterations so it runs on Workers Free. A real deployment uses 100000.";
const CLEARED = "__Host-demo_sandbox=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
const GUIDES: Readonly<Record<string, string>> = {
  "/password": "https://authtempo.com/docs/guides/password/",
  "/magic-link": "https://authtempo.com/docs/guides/magic-link/",
  "/email-code": "https://authtempo.com/docs/guides/email-code/",
  "/passkey": "https://authtempo.com/docs/guides/passkeys/",
  "/social": "https://authtempo.com/docs/guides/social/",
  "/second-factor": "https://authtempo.com/docs/guides/second-factor/",
  "/tokens": "https://authtempo.com/docs/guides/api-tokens/",
  "/organizations": "https://authtempo.com/docs/guides/organizations/",
};
const PROVIDER_QUERY = new URLSearchParams({
  response_type: "code",
  client_id: "demo-provider-client",
  redirect_uri: `${ORIGIN}/auth/social/demo/callback`,
  state: "s",
  code_challenge: "c",
  code_challenge_method: "S256",
});
const PROVIDER_PAGE = `/provider/authorize?${PROVIDER_QUERY}`;

/** Each page of DEMO_PAGES and the provider page of one new sandbox, as [path, html]. */
async function allPages() {
  const jar = await newSandbox();
  const out: [string, string][] = [];
  for (const path of [...DEMO_PAGES.map((p) => p.path), PROVIDER_PAGE]) {
    const res = await call(jar, "GET", path);
    expect(res.status, path).toBe(200);
    out.push([path, await res.text()]);
  }
  return { jar, pages: out };
}

function stub(id: string) {
  return env.SANDBOX.get(env.SANDBOX.idFromName(id));
}

describe("the demo pages", () => {
  it("serves each page of DEMO_PAGES with the layout and the reset time", async () => {
    const jar = await newSandbox();
    const [row] = await rowsIn(jar, "SELECT value FROM demo_meta WHERE key = 'reset_at'");
    const iso = new Date(Number(row?.value)).toISOString();
    let served = 0;
    for (const p of DEMO_PAGES) {
      const res = await call(jar, "GET", p.path);
      expect(res.status, p.path).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const doc = await res.text();
      expect(doc).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
      expect(doc).toContain('<link rel="stylesheet" href="/assets/tokens.css">');
      expect(doc).toContain('<link rel="stylesheet" href="/assets/demo.css">');
      for (const q of DEMO_PAGES)
        expect(doc, `${p.path} links ${q.path}`).toContain(`<a href="${q.path}"`);
      expect(doc).toContain(`<a href="${p.path}" aria-current="page">`);
      expect(doc).toContain(
        `<p class="notice">Test data only. Do not use a real password. Everything is deleted at <time datetime="${iso}">${iso.slice(11, 16)} UTC</time>.</p>`,
      );
      expect(doc).toContain(
        '<form class="reset" method="post" action="/reset"><button type="submit">Start again</button></form>',
      );
      expect(doc).toContain(`<h1>${p.title}</h1>`);
      served++;
    }
    expect(served).toBe(10);
    // The two style sheets answer from the build.
    for (const sheet of ["/assets/tokens.css", "/assets/demo.css"]) {
      const res = await call(jar, "GET", sheet);
      expect(res.status, sheet).toBe(200);
      expect(await res.text()).toContain("--at-");
    }
  });

  it("puts the lowered-cost line on each password form", async () => {
    const { pages } = await allPages();
    let forms = 0;
    for (const [path, doc] of pages)
      for (const m of doc.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)) {
        if (!m[0].includes('type="password"')) continue;
        forms++;
        const after = doc.slice(m.index + m[0].length);
        expect(
          after.startsWith(`<p class="cost">${COST}</p>`),
          `${path}: ${m[0].slice(0, 80)}`,
        ).toBe(true);
      }
    // Password 4 (sign-up, sign-in, reset, change), email code 1 (reset), second factor 2.
    expect(forms).toBe(7);
  });

  it("sets the page CSP on every page", async () => {
    const { jar, pages } = await allPages();
    const answers: [string, Response][] = [];
    for (const [path] of pages) answers.push([path, await call(jar, "GET", path)]);
    answers.push(["/whoami", await call(jar, "GET", "/whoami")]);
    answers.push(["/nowhere", await call(jar, "GET", "/nowhere")]);
    answers.push(["POST /password", await call(jar, "POST", "/password", new URLSearchParams())]);
    answers.push(["first visit", await call({ cookies: new Map() }, "GET", "/")]);
    answers.push(["/reset", await call(jar, "POST", "/reset", new URLSearchParams())]);
    for (const [path, res] of answers) {
      expect(res.headers.get("content-security-policy"), path).toBe(POLICY);
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
    expect(answers.length).toBe(16);
  });

  it("keeps the headers of a page of core", async () => {
    const jar = await newSandbox();
    await call(jar, "POST", "/auth/magic-link/request", { email: "pat@example.com" });
    const link = await lastLink(jar, "pat@example.com");
    const res = await call(jar, "GET", `${link.pathname}${link.search}`);
    expect(res.status).toBe(200);
    // Core's own page policy and its strict-origin, which a form post of that page needs.
    expect(res.headers.get("content-security-policy")).toMatch(/^default-src 'none'; /);
    expect(res.headers.get("referrer-policy")).toBe("strict-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves no inline script and no inline style", async () => {
    const { jar, pages } = await allPages();
    let scripts = 0;
    for (const [path, doc] of pages) {
      expect(doc, path).not.toMatch(/<style\b/i);
      expect(doc, path).not.toMatch(/\sstyle\s*=/i);
      expect(doc, path).not.toMatch(/\son[a-z]+\s*=/i);
      const tags = [...doc.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
      const run = tags.filter((t) => !t.includes('type="application/json"'));
      expect(run.length, path).toBeLessThanOrEqual(1);
      for (const tag of run) {
        const src = /^<script type="module" src="(\/assets\/js\/[a-z-]+\.js)"><\/script>$/.exec(
          `${tag}</script>`,
        )?.[1];
        expect(src, `${path}: ${tag}`).toBeDefined();
        const res = await call(jar, "GET", src ?? "");
        expect(res.status, src).toBe(200);
        expect(res.headers.get("content-type"), src).toMatch(/javascript/);
        scripts++;
      }
    }
    // Eight method pages have a script; the home, the mailbox, and the provider page have none.
    expect(scripts).toBe(8);
  });

  it("serves an asset from the build and no file that a request names", async () => {
    const jar = await newSandbox();
    expect((await call(jar, "GET", "/assets/client/index.js")).status).toBe(200);
    expect((await call(jar, "GET", "/fonts/inter-400.woff2")).status).toBe(200);
    for (const path of [
      "/assets/%2e%2e/%2e%2e/src/worker.ts",
      "/assets/client/index.d.ts",
      "/assets/client/index.js.map",
      "/assets/js/password.ts",
      "/fonts/%2e%2e/%2e%2e/package.json",
    ]) {
      const res = await call(jar, "GET", path);
      expect(res.status, path).toBe(404);
    }
    // A miss under an asset folder never makes a sandbox on a first visit.
    const first = await call({ cookies: new Map() }, "GET", "/fonts/missing.woff2");
    expect(first.status).toBe(404);
    expect(first.headers.get("set-cookie")).toBeNull();
  });

  it("starts again: deletes the sandbox and clears the cookie", async () => {
    const jar = await newSandbox();
    const id = sandboxId(jar);
    await signInByLink(jar, "pat@example.com");
    const res = await call(jar, "POST", "/reset", new URLSearchParams());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(res.headers.get("set-cookie")).toBe(CLEARED);
    expect(jar.cookies.has(SANDBOX_COOKIE)).toBe(false);
    expect(await stub(id).exists()).toBe(false);
    expect(
      await rowsIn({ cookies: new Map([[SANDBOX_COOKIE, id]]) }, "SELECT name FROM sqlite_master"),
    ).toEqual([]);
    // The next visit gets a new sandbox.
    const next = await call(jar, "GET", "/");
    expect(next.status).toBe(303);
    expect(sandboxId(jar)).not.toBe(id);
  });

  it("resets nothing on a cross-site post to /reset with no sandbox cookie", async () => {
    const jar = await newSandbox();
    const id = sandboxId(jar);
    await signInByLink(jar, "pat@example.com");
    // The cookie names SameSite=Lax. Chrome gives a cookie with no SameSite
    // attribute two minutes of cross-site posts; an explicit Lax has none.
    const first = await call({ cookies: new Map() }, "GET", "/");
    expect(first.headers.get("set-cookie")).toContain("; SameSite=Lax;");
    // A browser sends no Lax cookie on a cross-site post, so the post names no sandbox.
    const res = await call({ cookies: new Map() }, "POST", "/reset", new URLSearchParams(), {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(res.status).toBe(303);
    expect(await stub(id).exists()).toBe(true);
    expect(await rowsIn(jar, "SELECT count(*) AS n FROM ta_user")).toEqual([{ n: 1 }]);
    expect((await call(jar, "GET", "/whoami")).status).toBe(200);
  });

  it("links each method page to its guide", async () => {
    const { pages } = await allPages();
    let linked = 0;
    for (const [path, doc] of pages) {
      const guide = GUIDES[path];
      if (guide === undefined) {
        expect(doc, path).not.toContain("Read the guide of this method");
        continue;
      }
      expect(doc.split(`<a href="${guide}">Read the guide of this method</a>`).length, path).toBe(
        2,
      );
      expect(doc, path).toContain('<pre id="exchange">No call yet.</pre>');
      linked++;
    }
    expect(linked).toBe(8);
  });
});

describe("the mailbox page and the provider page", () => {
  const NAME = '<img src=x onerror="alert(1)"> https://evil.example/x';

  it("escapes a name that a visitor sets, and links only the demo origin", async () => {
    const jar = await newSandbox();
    await signInByLink(jar, "ada@example.com");
    const created = await call(jar, "POST", "/auth/organizations/create", {
      slug: "probe",
      name: NAME,
    });
    expect(created.status).toBe(200);
    const { organization } = (await created.json()) as { organization: { id: string } };
    const invited = await call(jar, "POST", "/auth/organizations/invite", {
      organizationId: organization.id,
      email: "grace@example.com",
      role: "member",
    });
    expect(invited.status).toBe(200);
    const invite = await lastLink(jar, "grace@example.com");

    const doc = await (await call(jar, "GET", "/mailbox")).text();
    expect(doc).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(doc).not.toContain("<img");
    expect(doc).not.toContain('href="https://evil.example');
    expect(doc).toContain("https://evil.example/x");
    const href = invite.href.replace(/&/g, "&amp;");
    expect(doc).toContain(`<a href="${href}">${href}</a>`);
  });

  it("shows each code of a mail in a code element", async () => {
    const jar = await newSandbox();
    await call(jar, "POST", "/auth/otp/request", { email: "pat@example.com" });
    const code = await lastCode(jar, "pat@example.com");
    const doc = await (await call(jar, "GET", "/mailbox")).text();
    expect(doc).toContain(`<code>${code}</code>`);
  });

  it("lists the mails of this sandbox only, newest first", async () => {
    const mine = await newSandbox();
    const other = await newSandbox();
    await call(mine, "POST", "/auth/magic-link/request", { email: "first@example.com" });
    await call(mine, "POST", "/auth/magic-link/request", { email: "second@example.com" });
    const doc = await (await call(mine, "GET", "/mailbox")).text();
    const first = doc.indexOf("To first@example.com");
    const second = doc.indexOf("To second@example.com");
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);
    const theirs = await (await call(other, "GET", "/mailbox")).text();
    expect(theirs).toContain("The mailbox is empty.");
    expect(theirs).not.toContain("example.com");
  });

  it("titles the provider page and gives one button per identity and a free field", async () => {
    const jar = await newSandbox();
    const doc = await (await call(jar, "GET", PROVIDER_PAGE)).text();
    expect(doc).toContain("<h1>Demo provider: pick a test identity</h1>");
    for (const key of ["ada", "grace", "alan"])
      expect(doc).toContain(`<button type="submit" name="identity" value="${key}">`);
    expect(doc).toContain('<input type="email" name="email" maxlength="254" autocomplete="email">');
    expect(doc).toContain('<button type="submit" name="identity" value="free">');
    // The query of the request is escaped in the form action.
    const action = /<form class="call" method="post" action="([^"]*)">/.exec(doc)?.[1] ?? "";
    expect(action.startsWith("/provider/authorize?response_type=code&amp;client_id=")).toBe(true);
    expect(action).not.toMatch(/&(?!amp;)/);
  });
});
