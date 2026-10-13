import { describe, expect, it } from "vitest";
import manifest from "../package.json?raw";
import {
  emailOTPClient,
  magicLinkClient,
  organizationClient,
  passkeyClient,
} from "../src/client/plugins.js";
import {
  bearer,
  COMPAT_PLUGIN,
  emailOTP,
  expo,
  magicLink,
  organization,
  passkey,
} from "../src/plugins.js";

describe("plugin markers", () => {
  it("carry the Better Auth plugin id and the options as given", async () => {
    const send = async () => {};
    expect(organization({ creatorRole: "owner", sendInvitationEmail: send })).toEqual({
      kind: COMPAT_PLUGIN,
      id: "organization",
      options: { creatorRole: "owner", sendInvitationEmail: send },
    });
    expect(passkey({ rpID: "example.com", rpName: "Ex", origin: "https://example.com" }).id).toBe(
      "passkey",
    );
    expect(magicLink({ sendMagicLink: send }).id).toBe("magic-link");
    expect(emailOTP({ sendVerificationOTP: send })).toEqual({
      kind: COMPAT_PLUGIN,
      id: "email-otp",
      options: { sendVerificationOTP: send },
    });
    expect(bearer().id).toBe("bearer");
    expect(expo().id).toBe("expo");
    expect(organization().options).toEqual({});
  });

  it("client markers carry the id", () => {
    expect(
      [organizationClient(), passkeyClient(), magicLinkClient(), emailOTPClient()].map((p) => p.id),
    ).toEqual(["organization", "passkey", "magic-link", "email-otp"]);
  });
});

describe("the manifest", () => {
  it("has exactly one runtime dependency, @noble/hashes pinned to 2.4.0", () => {
    const m = JSON.parse(manifest) as { dependencies: Record<string, string> };
    expect(m.dependencies).toEqual({ "@noble/hashes": "2.4.0" });
  });

  it("maps every subpath export to a source file", () => {
    const sources = Object.keys(import.meta.glob("../src/**/*.{ts,tsx}"));
    const exports = (JSON.parse(manifest) as { exports: Record<string, { default: string }> })
      .exports;
    for (const [subpath, target] of Object.entries(exports)) {
      const source = target.default.replace("./dist/", "../src/").replace(/\.js$/, ".ts");
      expect({
        subpath,
        found: sources.includes(source) || sources.includes(`${source}x`),
      }).toEqual({ subpath, found: true });
    }
  });
});
