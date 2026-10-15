import { createClient } from "@authtempo/client";
import { ERROR_SHAPE_CASES, runErrorShapeSuite, SDKS_RUN } from "@authtempo/client/conformance";
import { createOAuthClient } from "@authtempo/client/oauth";
import { createHandoff, createNativeClient } from "@authtempo/handoff";
import { AuthProvider, useSession } from "@authtempo/react";
import { createVerifier } from "@authtempo/verify";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const BASE = "https://api.example.com";
const ISSUER = `${BASE}/auth`;
const REDIRECT = "consumera://auth";

runErrorShapeSuite("client", "core", (fetch) => createClient({ baseURL: BASE, fetch }).session());

runErrorShapeSuite("oauth client", "oauth", (fetch) =>
  createOAuthClient({
    issuer: ISSUER,
    clientId: "cl_x",
    redirectUri: "http://127.0.0.1:8123/cb",
    resource: `${BASE}/mcp`,
    scopes: ["openid"],
    fetch,
  }).refresh("or_x"),
);

runErrorShapeSuite("handoff", "core", (fetch) =>
  createHandoff({
    baseURL: BASE,
    redirect: REDIRECT,
    // The system browser returns a code; the fault is at the redeem.
    opener: { open: async () => `${REDIRECT}?code=hc_x` },
    fetch,
  }).signIn(),
);

runErrorShapeSuite("native client", "core", (fetch) =>
  createNativeClient({
    baseURL: BASE,
    fetch,
    handoff: createHandoff({
      baseURL: BASE,
      redirect: REDIRECT,
      opener: { open: async () => null },
    }),
    store: { get: async () => "ts_x", set: async () => {}, clear: async () => {} },
  }).session(),
);

runErrorShapeSuite("verifier", "core", (fetch) =>
  createVerifier({ issuer: ISSUER, accept: ["api-token"], fetch }).verifyRequest(
    new Request(`${BASE}/files`, { headers: { authorization: "Bearer tk_x" } }),
  ),
);

runErrorShapeSuite("react hook", "core", async (fetch) => {
  const client = createClient({ baseURL: BASE, fetch, broadcast: false });
  let seen: unknown = null;
  function Probe() {
    const { error } = useSession();
    seen = error;
    return null;
  }
  const el = document.createElement("div");
  const root = createRoot(el);
  root.render(
    <AuthProvider client={client}>
      <Probe />
    </AuthProvider>,
  );
  try {
    await vi.waitFor(() => expect(seen).not.toBeNull());
  } finally {
    // A wait that times out must not leave the root and its client mounted for the later cases.
    root.unmount();
  }
  return seen;
});

it("ran the suite for six SDKs, with every case", () => {
  console.log(
    `conformance: ${SDKS_RUN.length} SDKs ran ${ERROR_SHAPE_CASES.length} error-shape cases (${SDKS_RUN.join(", ")})`,
  );
  expect(SDKS_RUN).toEqual([
    "client",
    "oauth client",
    "handoff",
    "native client",
    "verifier",
    "react hook",
  ]);
});
