import { authEventHandler } from "@authtempo/vue/nuxt";
import { getAuth } from "../../utils/auth";

// Every route of core under /auth, the default basePath.
export default authEventHandler(getAuth);
