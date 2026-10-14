# The PBKDF2 probe (plan 12b)

This Worker runs one PBKDF2-HMAC-SHA256 derive at the count that a request
names. It measures the highest count that a deployed Worker can run. Core
keeps `PBKDF2_ITERATIONS` at 100000 until this measurement proves a higher
count (spec 9).

The tests run the handler in Node: the key rule, the count rule, and one
small derive. Only a deployed Worker can measure the cost. No test and no
plan deploys it. The owner runs the steps below.

Warning: delete the Worker after the run. A deployed probe spends CPU for each call that holds the key.

## The request

`GET /probe?iterations=<n>` with the header `x-probe-key: <key>`.

| Answer | When |
| --- | --- |
| 200 `{ iterations, ok, error, ms }` | The key is right, and `n` is an integer from 1 to 10000000. `ok: false` holds the exact error text of the derive. |
| 400 | `n` is not an integer from 1 to 10000000. |
| 403 | The key is missing or wrong, or the Worker has no `PROBE_KEY`. |
| 404 | Any other path. |

`ms` is not the CPU time. A Worker's clock does not move while its code
runs. Read the CPU time from the tail or from the invocation logs.

## The config

`wrangler.jsonc` sets `workers_dev` and `preview_urls` to false. A plain
`wrangler deploy` therefore gives no public URL. The environment `measure`
turns `workers_dev` on for the one run, and turns on the invocation logs.
Every command below names `--env measure`. Without it, a command acts on
the Worker `authtempo-pbkdf2-probe`, not on the probe of the run.

## The measurement (owner-run)

Run these steps on an account with Workers Paid. Workers Free gives 10 ms
of CPU per request, so a derive of 100000 iterations does not finish there.

1. Run `cd examples/pbkdf2-probe`.
2. Run `pnpm exec wrangler login`.
3. Run `pnpm exec wrangler deploy --env measure`. Note the `workers.dev` URL that it prints.

   The Worker has no key yet, so it answers 403 to every call.

4. Make a key, and store it as the secret of the probe:

   ```sh
   KEY=$(openssl rand -base64 32)
   printf '%s' "$KEY" | pnpm exec wrangler secret put PROBE_KEY --env measure
   URL=<the workers.dev URL of step 3>
   ```

   `printf` sends no newline. With `echo`, the stored key can end in a newline, and every call answers 403.

5. Check the key rule. This call must answer 403:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' "$URL/probe?iterations=1000"
   ```

   If it answers 200, stop. Run step 10 now: the Worker is open to every caller.

6. In a second terminal, run `cd examples/pbkdf2-probe`. Then start the tail:

   ```sh
   pnpm exec wrangler tail --env measure --format json > pbkdf2-tail.jsonl
   ```

7. In the first terminal, run each count five times:

   ```sh
   for n in 100000 200000 310000 600000 1000000; do
     for i in 1 2 3 4 5; do
       curl -s -H "x-probe-key: $KEY" "$URL/probe?iterations=$n" | tee -a pbkdf2-answers.jsonl
       echo
     done
   done
   ```

   Each line of `pbkdf2-answers.jsonl` holds `ok` and the exact `error` text of one call.

8. Wait 10 seconds, then stop the tail with Ctrl-C.
9. Read `outcome`, `cpuTime`, `event.request.url`, and `event.request.cf.colo` of each call:

   ```sh
   jq -c '{url: .event.request.url, outcome, cpuTime, colo: .event.request.cf.colo}' pbkdf2-tail.jsonl
   ```

   The tail docs (read 2026-10-15) show no `cpuTime` field in their example. If `cpuTime` is null, read the CPU time of each call in the dashboard: Workers, `authtempo-pbkdf2-probe-measure`, Logs.

10. Delete the Worker and the files:

    ```sh
    pnpm exec wrangler delete --env measure
    rm pbkdf2-tail.jsonl pbkdf2-answers.jsonl
    ```

    Without the delete, the Worker stays live with its key.

## What the run must produce

The highest count that passes, and its median CPU time in milliseconds.
Record with it:

| Field | Value |
| --- | --- |
| Date of the run | `<to fill>` |
| Account plan | `<to fill: Workers Paid>` |
| Compatibility date | `2026-09-30` |
| Colo | `<to fill>` |
| Median CPU time of 100000 | `<to fill>` |
| Median CPU time of 200000 | `<to fill>` |
| Median CPU time of 310000 | `<to fill>` |
| Median CPU time of 600000 | `<to fill>` |
| Median CPU time of 1000000 | `<to fill>` |
| The first count that fails | `<to fill>` |
| Its exact error text, or its `outcome` | `<to fill>` |
| The highest count that passes | `<to fill>` |

The binary of workerd 1.20261006.1 holds this error text:

```text
Pbkdf2 failed: iteration counts above <max> are not supported (requested <n>).
```

A count over the CPU limit gives the `outcome` `exceededCpu` instead.

## The decision rule

Raise `PBKDF2_ITERATIONS` in `packages/core/src/seams/password-hash.ts` to
the highest passing count whose median CPU time is under 200 ms. Else keep
100000. A stored hash with a lower cost rehashes at the next sign-in (spec 9).
`maxIterations` defaults to the same constant, so the seam then verifies
the new count too.

## Where the result goes

- One dated line at the end of spec section 9, with the figures and the conditions.
- The constant and its comment in `seams/password-hash.ts`, with the date of the run.
- The "Workers Paid" sentence of the core README, section "Passwords".
- One evidence line in the plan index.

If the owner has not run it when the rest of plan 12b merges, the constant
stays at 100000. The index then keeps the plan 8 input open with one dated
line that says so.
