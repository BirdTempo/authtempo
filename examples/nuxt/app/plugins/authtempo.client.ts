import { createClient } from "@authtempo/client";
import { authPlugin } from "@authtempo/vue";

// The browser side: the session store in Vue, for useSession() in any component.
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(authPlugin(createClient({ baseURL: window.location.origin })));
});
