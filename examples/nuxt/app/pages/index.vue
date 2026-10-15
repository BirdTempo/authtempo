<script setup lang="ts">
// biome-ignore lint/style/useVueMultiWordComponentNames: Nuxt names a page by its file, and the file name is the URL /.
import { useSession } from "@authtempo/vue";

// On the server, the session middleware put the session in the request's context.
// useState carries the value to the browser, so the hydration shows the same text.
const event = useRequestEvent();
// biome-ignore lint/correctness/noUnusedVariables: Biome reads the script only; the template below reads email.
const email = useState("email", () => event?.context.session?.user.email ?? null);
// The browser's store through the Vue binding. The server render shows "pending"
// and starts no read; the browser then reads the session and shows it.
// biome-ignore lint/correctness/noUnusedVariables: Biome reads the script only; the template below reads session.
const { session } = useSession();
</script>

<template>
  <p v-if="email">Signed in as {{ email }}</p>
  <a v-else href="/sign-in">Sign in</a>
  <p>Browser session: {{ session.isPending ? "pending" : (session.data?.user.email ?? "signed out") }}</p>
</template>
