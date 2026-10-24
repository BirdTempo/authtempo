import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createWechatAuth } from "./wechat.ts";

describe("sign in with WeChat", () => {
  it("sends the person to the WeChat QR page with the app id and the fragment", async () => {
    const auth = createWechatAuth(harness());
    const res = await call(auth, "GET", "/auth/social/wechat/start?next=/home");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.endsWith("#wechat_redirect")).toBe(true);
    const to = new URL(location);
    expect(to.origin + to.pathname).toBe("https://open.weixin.qq.com/connect/qrconnect");
    expect(to.searchParams.get("appid")).toBe("wx-app-id");
    expect(to.searchParams.get("scope")).toBe("snsapi_login");
    // The WeChat docs name no PKCE, so the entry sends none.
    expect(to.searchParams.has("code_challenge")).toBe(false);
  });
});
