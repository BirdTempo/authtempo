import { createClient } from "@authtempo/client";
import { authPlugin } from "@authtempo/vue";

// The session store in Vue, for useSession() in any component. No .client
// suffix: the plugin runs in the server render too, else a page that calls
// useSession() fails there with "a composable needs app.use(authPlugin(client))".
// Nuxt makes a new app per server request, so each request gets its own client.
// useRequestURL() answers the request's URL on the server and the page's URL in
// the browser. A server render subscribes to nothing and reads nothing.
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(authPlugin(createClient({ baseURL: useRequestURL().origin })));
});
