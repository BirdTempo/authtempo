// core is not on the allow list of copy-assets.mjs: only two of its entries are.
import { createAuth } from "@authtempo/core";

export const inner = createAuth;
