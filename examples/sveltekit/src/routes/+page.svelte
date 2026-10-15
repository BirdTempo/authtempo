<script>
// biome-ignore lint/correctness/noUnusedVariables: Biome reads the script only; the template below reads data.
let { data } = $props();
</script>

{#if data.email}
  <p>Signed in as {data.email}</p>
{:else}
  <a href="/sign-in">Sign in</a>
{/if}
