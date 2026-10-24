import { describe, expect, it } from "vitest";
import { harness } from "../support/harness.ts";
import { createDeploymentAuth, type DeployEnv } from "./preview-deployments.ts";

const PREVIEW: DeployEnv = {
  API_ORIGIN: "https://pr-42.preview.example.com",
  APP_ORIGIN: "https://pr-42-app.preview.example.com",
  // Path 1: the OAuth app of this preview host.
  GITHUB_CLIENT_ID: "preview-42-client-id",
  GITHUB_CLIENT_SECRET: "preview-42-client-secret",
};

describe("social sign-in on a preview deployment", () => {
  it("sends the callback of the preview host, never of production", async () => {
    const auth = createDeploymentAuth(harness(), PREVIEW);
    const res = await auth.handle(
      new Request("https://pr-42.preview.example.com/auth/social/github/start"),
    );
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.searchParams.get("client_id")).toBe("preview-42-client-id");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://pr-42.preview.example.com/auth/social/github/callback",
    );
  });
});
