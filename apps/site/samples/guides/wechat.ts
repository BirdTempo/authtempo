import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";
import { wechatEntry } from "@authtempo/core/social-entries";

export function createWechatAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    appURL: "https://app.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    social: {
      // The AppID and the AppSecret of a website app on the WeChat Open Platform.
      oauth2: [wechatEntry({ appId: "wx-app-id", appSecret: "wechat-app-secret" })],
    },
  });
}
