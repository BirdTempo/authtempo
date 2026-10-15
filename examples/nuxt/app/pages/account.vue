<script setup lang="ts">
// The session middleware sends a person with no session to /sign-in before this page renders.
// biome-ignore lint/style/useVueMultiWordComponentNames: Nuxt names a page by its file, and the file name is the URL /account.
const event = useRequestEvent();
// biome-ignore lint/correctness/noUnusedVariables: Biome reads the script only; the template below reads email.
const email = useState("email", () => event?.context.session?.user.email ?? null);
</script>

<template>
  <p>Your account: {{ email }}</p>
</template>
