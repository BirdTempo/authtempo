import { SoftAuthenticator } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  browserWebAuthn,
  credentialToJSON,
  type PublicKeyCredentialLike,
  supportsPasskeys,
  toBinaryCreationOptions,
  toBinaryRequestOptions,
  WebAuthnCancelled,
} from "../src/webauthn.js";

const RP = { id: "example.com", name: "Example" };
const ORIGIN = "https://example.com";

/** A fake `PublicKeyCredential` with ArrayBuffer fields, built from the soft authenticator's JSON. */
function binaryCredential(json: {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment: "platform";
  clientExtensionResults: Record<string, never>;
  response: Record<string, string | string[] | undefined>;
}) {
  const response: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json.response)) {
    if (k === "transports") continue;
    if (typeof v === "string") response[k] = base64UrlDecode(v);
  }
  const transports = json.response.transports;
  if (Array.isArray(transports)) response.getTransports = () => transports;
  return {
    id: json.id,
    rawId: base64UrlDecode(json.rawId),
    type: json.type,
    authenticatorAttachment: json.authenticatorAttachment,
    response: response as unknown as PublicKeyCredentialLike["response"],
    getClientExtensionResults: () => json.clientExtensionResults,
  };
}

describe("base64url", () => {
  it("round-trips bytes and rejects padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const s = base64UrlEncode(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect(new Uint8Array(base64UrlDecode(s))).toEqual(bytes);
    expect(base64UrlEncode(base64UrlDecode("AQID"))).toBe("AQID");
  });
});

describe("conversions", () => {
  it("decodes the binary fields of creation options and keeps the rest", () => {
    const bin = toBinaryCreationOptions({
      rp: RP,
      user: { id: "dXNlcg", name: "ada@example.com", displayName: "ada@example.com" },
      challenge: "Y2hhbGxlbmdl",
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ id: "Y3JlZA", type: "public-key", transports: ["internal"] }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    expect(new TextDecoder().decode(bin.challenge as ArrayBuffer)).toBe("challenge");
    expect(new TextDecoder().decode(bin.user.id as ArrayBuffer)).toBe("user");
    expect(new TextDecoder().decode(bin.excludeCredentials?.[0]?.id as ArrayBuffer)).toBe("cred");
    expect(bin.excludeCredentials?.[0]?.transports).toEqual(["internal"]);
    expect(bin.authenticatorSelection?.residentKey).toBe("required");
  });

  it("decodes the binary fields of request options", () => {
    const bin = toBinaryRequestOptions({
      challenge: "Y2hhbGxlbmdl",
      rpId: RP.id,
      allowCredentials: [{ id: "Y3JlZA", type: "public-key" }],
      userVerification: "required",
    });
    expect(new TextDecoder().decode(bin.challenge as ArrayBuffer)).toBe("challenge");
    expect(new TextDecoder().decode(bin.allowCredentials?.[0]?.id as ArrayBuffer)).toBe("cred");
    expect(bin.rpId).toBe(RP.id);
  });

  it("turns a binary credential back into the JSON the soft authenticator made", async () => {
    const soft = await SoftAuthenticator.create({ rpID: RP.id, origin: ORIGIN });
    const reg = await soft.register("Y2hhbGxlbmdl", new TextEncoder().encode("user"));
    expect(credentialToJSON(binaryCredential(reg))).toEqual(reg);
    const auth = await soft.authenticate("Y2hhbGxlbmdl");
    expect(credentialToJSON(binaryCredential(auth))).toEqual(auth);
  });
});

describe("browserWebAuthn", () => {
  it("drives a credentials container through the package's own conversion when the platform parsers are absent", async () => {
    const soft = await SoftAuthenticator.create({ rpID: RP.id, origin: ORIGIN });
    const seen: unknown[] = [];
    const container = {
      async create(init: { publicKey?: PublicKeyCredentialCreationOptions }) {
        seen.push(init.publicKey);
        const challenge = base64UrlEncode(init.publicKey?.challenge as ArrayBuffer);
        return binaryCredential(await soft.register(challenge));
      },
      async get(init: { publicKey?: PublicKeyCredentialRequestOptions }) {
        seen.push(init.publicKey);
        const challenge = base64UrlEncode(init.publicKey?.challenge as ArrayBuffer);
        return binaryCredential(await soft.authenticate(challenge));
      },
    };
    const w = browserWebAuthn(container);
    const reg = await w.create({
      rp: RP,
      user: { id: "dXNlcg", name: "a", displayName: "a" },
      challenge: "Y2hhbGxlbmdl",
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    });
    expect(reg.response.attestationObject).toMatch(/^[A-Za-z0-9_-]+$/);
    const got = await w.get({ challenge: "Y2hhbGxlbmdl", rpId: RP.id });
    expect(got.response.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((seen[0] as PublicKeyCredentialCreationOptions).challenge).toBeInstanceOf(ArrayBuffer);
  });

  it("uses the platform parsers when PublicKeyCredential has them", async () => {
    const calls: string[] = [];
    const fake = {
      parseCreationOptionsFromJSON: (j: unknown) => {
        calls.push("parseCreation");
        return j;
      },
      parseRequestOptionsFromJSON: (j: unknown) => {
        calls.push("parseRequest");
        return j;
      },
    };
    const prev = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = fake;
    try {
      const container = {
        async create() {
          return { toJSON: () => ({ id: "x", response: { clientDataJSON: "y" } }) };
        },
        async get() {
          return { toJSON: () => ({ id: "x", response: { clientDataJSON: "y" } }) };
        },
      };
      const w = browserWebAuthn(container);
      const reg = await w.create({
        rp: RP,
        user: { id: "a", name: "a", displayName: "a" },
        challenge: "a",
        pubKeyCredParams: [],
      });
      expect(reg.id).toBe("x");
      await w.get({ challenge: "a" });
      expect(calls).toEqual(["parseCreation", "parseRequest"]);
      expect(supportsPasskeys()).toBe(true);
    } finally {
      (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = prev;
    }
    expect(supportsPasskeys()).toBe(false);
  });

  it("throws WebAuthnCancelled on a NotAllowedError and rethrows other errors", async () => {
    const notAllowed = Object.assign(
      new Error("The operation either timed out or was not allowed"),
      {
        name: "NotAllowedError",
      },
    );
    const w = browserWebAuthn({
      async create() {
        throw notAllowed;
      },
      async get() {
        throw new Error("boom");
      },
    });
    await expect(
      w.create({
        rp: RP,
        user: { id: "YQ", name: "a", displayName: "a" },
        challenge: "YQ",
        pubKeyCredParams: [],
      }),
    ).rejects.toBeInstanceOf(WebAuthnCancelled);
    await expect(w.get({ challenge: "YQ" })).rejects.toThrow("boom");
  });
});
