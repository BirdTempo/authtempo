import { describe, expect, it } from "vitest";
import { call, harness, signIn } from "../support/harness.ts";
import { createClientsAuth, createDeviceClient, createServiceClient } from "./oauth-clients.ts";

const API = "https://api.example.com";
const RESOURCE = `${API}/mcp`;

/** A form post to a provider route, with no Origin header: a server or a device. */
function form(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("serve services and devices with the OAuth provider", () => {
  it("gives a service a token for no person with the client_credentials grant", async () => {
    const auth = createClientsAuth(harness());
    const { clientId, clientSecret } = await createServiceClient(auth);
    expect(clientSecret.startsWith("cs_")).toBe(true);
    // client_secret_basic: HTTP Basic of the form-encoded id and secret (RFC 6749 section 2.3.1).
    const basic = btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`);
    const res = await auth.handle(
      form(
        "/auth/oauth/token",
        { grant_type: "client_credentials", resource: RESOURCE, scope: "reports:read" },
        { authorization: `Basic ${basic}` },
      ),
    );
    expect(res.status).toBe(200);
    const token = (await res.json()) as Record<string, unknown>;
    expect(token.token_type).toBe("Bearer");
    expect(token.scope).toBe("reports:read");
    expect(token.refresh_token).toBeUndefined();

    const caller = await auth.caller(
      new Request(RESOURCE, { headers: { authorization: `Bearer ${String(token.access_token)}` } }),
    );
    expect(caller?.kind).toBe("oauth-client");
    expect(caller?.kind === "oauth-client" ? caller.clientId : null).toBe(clientId);

    // A wrong secret after an Authorization header: 401 with the Basic challenge.
    const wrong = btoa(`${encodeURIComponent(clientId)}:cs_wrong`);
    const refused = await auth.handle(
      form(
        "/auth/oauth/token",
        { grant_type: "client_credentials", resource: RESOURCE },
        { authorization: `Basic ${wrong}` },
      ),
    );
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "invalid_client" });
    expect(refused.headers.get("www-authenticate")).toBe(`Basic realm="${API}/auth"`);
  });

  it("lets a person approve a device code, and the device polls once for its tokens", async () => {
    const h = harness();
    const auth = createClientsAuth(h);
    const clientId = await createDeviceClient(auth);

    const start = await auth.handle(
      form("/auth/oauth/device_authorization", {
        client_id: clientId,
        scope: "mcp:tools",
        resource: RESOURCE,
      }),
    );
    expect(start.status).toBe(200);
    const device = (await start.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval: number;
    };
    expect(device.verification_uri).toBe(`${API}/auth/oauth/device`);
    expect(device.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(device.interval).toBe(5);

    // The person signs in on a phone or a laptop and types the code on the device page.
    const cookie = await signIn(auth, h, "ada@example.com");
    const page = { cookie, origin: API };
    const consent = await auth.handle(
      form("/auth/oauth/device", { user_code: device.user_code }, page),
    );
    expect(await consent.text()).toContain("Approve only a device that is in front of you.");
    const allow = await auth.handle(
      form("/auth/oauth/device", { user_code: device.user_code, decision: "allow" }, page),
    );
    expect(allow.status).toBe(200);

    const poll = { grant_type: DEVICE_URN, device_code: device.device_code, client_id: clientId };
    const tokens = await auth.handle(form("/auth/oauth/token", poll));
    expect(tokens.status).toBe(200);
    expect(((await tokens.json()) as { scope: string }).scope).toBe("mcp:tools");
    // An approved code gives its tokens once.
    const again = await auth.handle(form("/auth/oauth/token", poll));
    expect(await again.json()).toEqual({ error: "invalid_grant" });
  });

  it("refuses a device poll before the person decides", async () => {
    const auth = createClientsAuth(harness());
    const clientId = await createDeviceClient(auth);
    const start = await auth.handle(
      form("/auth/oauth/device_authorization", {
        client_id: clientId,
        scope: "mcp:tools",
        resource: RESOURCE,
      }),
    );
    const { device_code } = (await start.json()) as { device_code: string };
    const poll = await auth.handle(
      form("/auth/oauth/token", { grant_type: DEVICE_URN, device_code, client_id: clientId }),
    );
    expect(poll.status).toBe(400);
    expect(await poll.json()).toEqual({ error: "authorization_pending" });
    // The page route exists only while oauth.device is on; a signed-out browser goes to the sign-in step.
    const signedOut = await call(auth, "GET", "/auth/oauth/device");
    expect(signedOut.status).toBe(302);
  });
});

/** RFC 8628 section 3.4. Typed here, so the test does not read the constant it checks. */
const DEVICE_URN = "urn:ietf:params:oauth:grant-type:device_code";
