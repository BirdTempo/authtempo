import { describe, expect, it } from "vitest";
import { defaultConsentPage } from "../src/http/consent-page.js";
import { consentPagePolicy } from "../src/http/csp.js";
import { makeAuth } from "./helpers.js";

const input = {
  action: "/auth/oauth/authorize",
  appName: "Acme & Co",
  clientName: `Evil "client" <b>`,
  clientId: "cl_x",
  redirectTo: "https://client.example.com",
  email: "ada@example.com",
  scopes: [{ name: "mcp:read", description: "Read <your> documents" }],
  fields: { client_id: "cl_x", state: `"><script>` },
};

describe("the consent page (plan 9g)", () => {
  it("escapes every value, posts the fields back, and offers allow and deny with no script", () => {
    const html = defaultConsentPage(input);
    expect(html).toContain("Evil &quot;client&quot; &lt;b&gt;");
    expect(html).toContain("Read &lt;your&gt; documents");
    expect(html).toContain('<input type="hidden" name="state" value="&quot;&gt;&lt;script&gt;">');
    expect(html).toContain('<input type="hidden" name="client_id" value="cl_x">');
    expect(html).toContain('<form method="post" action="/auth/oauth/authorize">');
    expect(html).toContain('<button type="submit" name="decision" value="allow">Allow</button>');
    expect(html).toContain('<button type="submit" name="decision" value="deny">Deny</button>');
    expect(html).toContain("Signed in as ada@example.com");
    expect(html).toContain("After your answer, the browser goes to https://client.example.com.");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
  });

  it("adds the redirect's origin or scheme to form-action, and nothing for an IPv6 literal", () => {
    const { config } = makeAuth();
    expect(consentPagePolicy(config, "https://client.example.com/cb?x=1")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.example.com https://client.example.com; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(consentPagePolicy(config, "com.example.app:/cb")).toContain(
      "form-action 'self' https://app.example.com com.example.app:;",
    );
    expect(consentPagePolicy(config, "http://[::1]:9/cb")).toContain(
      "form-action 'self' https://app.example.com;",
    );
  });
});
