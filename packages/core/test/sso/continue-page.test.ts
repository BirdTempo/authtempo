import { describe, expect, it } from "vitest";
import { ssoContinuePage } from "../../src/http/sso-continue-page.js";

describe("the continue page of the SSO form (plan 12d Task 4b)", () => {
  it("holds the location and the app name in their escaped forms only", () => {
    const html = ssoContinuePage({
      location: `/auth/sso/c1/start?next=/a&b="><script>x</script>`,
      appName: `Acme & "Co" <b>`,
    });
    const escaped = "/auth/sso/c1/start?next=/a&amp;b=&quot;&gt;&lt;script&gt;x&lt;/script&gt;";
    expect(html).toContain(`<meta http-equiv="refresh" content="0; url=${escaped}">`);
    expect(html).toContain(`<a href="${escaped}">Continue</a>`);
    expect(html).toContain(
      "<title>Continue to sign in to Acme &amp; &quot;Co&quot; &lt;b&gt;</title>",
    );
    expect(html).toContain("<h1>Continue to sign in to Acme &amp; &quot;Co&quot; &lt;b&gt;</h1>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain('b=">');
    expect(html).not.toContain("a&b");
  });
});
