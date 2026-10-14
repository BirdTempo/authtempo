import { createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

export function createEmailCodeAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    // Email codes are on by default. `emailOtp: false` turns them off.
    emailOtp: {
      // 6 or 8 digits. Eight digits divide the odds of a guess by 100.
      length: 8,
      // The life of a code, 1 to 60 minutes. The default is 10.
      ttlMinutes: 10,
      // The wrong codes that spend a code, 3 to 10. The default is 5.
      maxAttempts: 5,
    },
  });
}
