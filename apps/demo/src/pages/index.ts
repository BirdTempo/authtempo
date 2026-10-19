import { emailCodePage } from "./email-code.js";
import { homePage } from "./home.js";
import type { DemoPath, PageBody } from "./layout.js";
import { magicLinkPage } from "./magic-link.js";
import { mailboxPage } from "./mailbox.js";
import { organizationsPage } from "./organizations.js";
import { passkeyPage } from "./passkey.js";
import { passwordPage } from "./password.js";
import { secondFactorPage } from "./second-factor.js";
import { socialPage } from "./social.js";
import { tokensPage } from "./tokens.js";

/** The body of each page of DEMO_PAGES. The type fails the compile when a page has no body. */
export const DEMO_BODIES: Readonly<Record<DemoPath, PageBody>> = {
  "/": homePage,
  "/password": passwordPage,
  "/magic-link": magicLinkPage,
  "/email-code": emailCodePage,
  "/passkey": passkeyPage,
  "/social": socialPage,
  "/second-factor": secondFactorPage,
  "/tokens": tokensPage,
  "/organizations": organizationsPage,
  "/mailbox": mailboxPage,
};
