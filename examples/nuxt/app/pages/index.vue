<script setup lang="ts">
// On the server, the session middleware put the session in the request's context.
// useState carries the value to the browser, so the hydration shows the same text.
// biome-ignore lint/style/useVueMultiWordComponentNames: Nuxt names a page by its file, and the file name is the URL /.
const event = useRequestEvent();
// biome-ignore lint/correctness/noUnusedVariables: Biome reads the script only; the template below reads email.
const email = useState("email", () => event?.context.session?.user.email ?? null);
</script>

<template>
  <p v-if="email">Signed in as {{ email }}</p>
  <a v-else href="/sign-in">Sign in</a>
</template>
